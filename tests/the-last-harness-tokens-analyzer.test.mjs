import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { analyzeCurrentSessionUsage, analyzeSessionEntries } = await jiti.import(
	"../extensions/the-last-harness/tokens-analyzer.ts",
);

function assistantEntry(id, parentId, timestamp, options = {}) {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			provider: options.provider ?? "openai-codex",
			model: options.model ?? "gpt-5.5",
			stopReason: options.stopReason ?? "stop",
			content: options.content ?? [{ type: "text", text: options.text ?? "assistant text" }],
			usage: options.usage,
		},
	};
}

function userEntry(id, parentId, timestamp, text) {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "user",
			content: [{ type: "text", text }],
		},
	};
}

function toolResultEntry(id, parentId, timestamp, toolName, details, isError = false, contentText = "tool output") {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "toolResult",
			toolName,
			toolCallId: `${id}-call`,
			isError,
			content: [{ type: "text", text: contentText }],
			details,
		},
	};
}

function usage({ input, output, cacheRead = 0, cacheWrite = 0, cost, turns = 0, assistantMessages = 0 }) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost: {
			total: cost,
			input: cost / 2,
			output: cost / 2,
			cacheRead: 0,
			cacheWrite: 0,
		},
		turns,
		assistantMessages,
	};
}

function analyzeSingleSubagentResult(details) {
	return analyzeSessionEntries([
		assistantEntry("a1", null, "2026-06-16T00:00:00Z", {
			stopReason: "tool_use",
			content: [{ type: "toolCall", id: "call-subagent-1", name: "subagent", arguments: { task: "task" } }],
		}),
		toolResultEntry("tr1", "a1", "2026-06-16T00:00:01Z", "subagent", details),
	], { toolCatalog });
}

const toolCatalog = [
	{
		name: "bash",
		sourceInfo: { source: "built-in", path: "core/tools/bash.ts", scope: "user", origin: "top-level" },
	},
	{
		name: "subagent",
		sourceInfo: { source: "npm:pi-subagents", path: "extensions/subagent.mjs", scope: "user", origin: "package" },
	},
	{
		name: "mcp",
		sourceInfo: { source: "npm:pi-mcp-adapter", path: "extensions/mcp.mjs", scope: "user", origin: "package" },
	},
	{
		name: "exa_search",
		sourceInfo: { source: "npm:pi-mcp-adapter", path: "extensions/direct-tools/exa.mjs", scope: "user", origin: "package" },
	},
];

test("analyzeSessionEntries summarizes exact assistant usage, estimated tool attribution, and redacted subagent discoveries", () => {
	const entries = [
		userEntry("u1", null, "2026-06-15T12:00:00Z", "SECRET USER PROMPT"),
		assistantEntry("a1", "u1", "2026-06-15T12:00:05Z", {
			stopReason: "tool_use",
			content: [
				{ type: "text", text: "Planning text that should stay out of the report." },
				{ type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "call-subagent-1", name: "subagent", arguments: { task: "RAW SUBAGENT TASK" } },
			],
			usage: usage({ input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: 0.35 }),
		}),
		toolResultEntry("tr1", "a1", "2026-06-15T12:00:06Z", "bash", { exitCode: 0 }, false, "RAW TOOL OUTPUT"),
		toolResultEntry(
			"tr2",
			"a1",
			"2026-06-15T12:00:08Z",
			"subagent",
			{
				agent: "developer",
				mode: "single",
				model: "openai-codex/gpt-5.4",
				intercomTarget: "subagent-chat-123",
				sessionFile: "/Users/me/.the-last-harness/agent/sessions/--repo--/run-42/session.jsonl",
				artifactPaths: {
					outputPath: "/Users/me/.the-last-harness/agent/artifacts/run-42/output.md",
					metadataPath: "/Users/me/.the-last-harness/agent/artifacts/run-42/metadata.json",
				},
				modelAttempts: [
					{
						model: "openai-codex/gpt-5.4",
						success: true,
						usage: usage({ input: 50, output: 10, cacheRead: 4, cacheWrite: 1, cost: 0.12, turns: 1, assistantMessages: 1 }),
					},
				],
				output: "raw scratchpad",
			},
			false,
			"RAW SUBAGENT RESULT",
		),
		assistantEntry("a2", "tr2", "2026-06-15T12:00:15Z", {
			stopReason: "tool_use",
			content: [
				{ type: "text", text: "Fetching MCP data." },
				{ type: "toolCall", id: "call-mcp-1", name: "mcp", arguments: { server: "exa", prompt: "secret query" } },
			],
			usage: usage({ input: 80, output: 15, cost: 0.25 }),
		}),
		toolResultEntry("tr3", "a2", "2026-06-15T12:00:18Z", "mcp", { server: "exa" }, false, "MCP RAW RESULT"),
		assistantEntry("a3", "tr3", "2026-06-15T12:00:25Z", {
			text: "Done.",
			usage: usage({ input: 60, output: 25, cacheRead: 10, cost: 0.22 }),
		}),
		assistantEntry("a-branch", "u1", "2026-06-15T12:01:00Z", {
			text: "Alternate branch",
			usage: usage({ input: 10, output: 5, cost: 0.04 }),
		}),
	];

	const analysis = analyzeSessionEntries(entries, {
		sessionId: "session-1",
		sessionName: "Token report",
		startedAt: "2026-06-15T12:00:00Z",
		activeLeafId: "a3",
		toolCatalog,
	});

	assert.equal(analysis.session.sessionId, "session-1");
	assert.equal(analysis.session.sessionName, "Token report");
	assert.equal(analysis.session.entryCount, 8);
	assert.equal(analysis.session.leafCount, 3);
	assert.equal(analysis.session.assistantTurnsOnActiveBranch, 3);
	assert.equal(analysis.session.assistantTurnsOffActiveBranch, 1);

	assert.deepEqual(analysis.totals.primary, {
		inputTokens: 250,
		outputTokens: 65,
		cacheReadTokens: 40,
		cacheWriteTokens: 5,
		totalTokens: 360,
		costUsd: 0.86,
		turns: 4,
		assistantMessages: 4,
	});
	assert.deepEqual(analysis.totals.subagents, {
		inputTokens: 50,
		outputTokens: 10,
		cacheReadTokens: 4,
		cacheWriteTokens: 1,
		totalTokens: 65,
		costUsd: 0.12,
		turns: 1,
		assistantMessages: 1,
	});
	assert.equal(analysis.totals.combined.totalTokens, 425);
	assert.equal(analysis.primaryAssistant.usageCoverage.withUsage, 4);
	assert.equal(analysis.primaryAssistant.timeline.length, 4);
	assert.equal(analysis.primaryAssistant.timeline[0].toolCalls.total, 2);
	assert.equal(analysis.primaryAssistant.timeline[0].discoveries.subagentRuns, 1);
	assert.equal(analysis.primaryAssistant.timeline[0].discoveries.artifactReferences, 2);
	assert.equal(analysis.primaryAssistant.timeline[0].discoveries.sessionReferences, 1);
	assert.equal(analysis.primaryAssistant.timeline[0].discoveries.intercomTargets, 1);
	assert.equal(analysis.primaryAssistant.timeline[1].toolCalls.mcp, 1);
	assert.equal(analysis.primaryAssistant.timeline[1].toolResults.total, 1);
	assert.equal(analysis.primaryAssistant.timeline[3].activeBranch, false);

	assert.equal(analysis.tools.totalCalls, 3);
	assert.equal(analysis.tools.totalResults, 3);
	assert.equal(analysis.tools.totalErrors, 0);
	assert.equal(analysis.tools.mcpCalls, 1);
	assert.equal(analysis.tools.mcpProxyCalls, 1);
	assert.equal(analysis.tools.mcpDirectCalls, 0);
	assert.equal(analysis.tools.bySource.length, 3);
	assert.equal(analysis.tools.byTool.find((tool) => tool.toolName === "bash")?.source.kind, "built-in");
	assert.equal(analysis.tools.byTool.find((tool) => tool.toolName === "subagent")?.source.kind, "extension");
	assert.equal(analysis.tools.byTool.find((tool) => tool.toolName === "mcp")?.source.kind, "mcp-proxy");

	assert.equal(analysis.subagents.runCount, 1);
	assert.equal(analysis.subagents.runs[0].agent, "developer");
	assert.equal(analysis.subagents.runs[0].model, "openai-codex/gpt-5.4");
	assert.equal(analysis.subagents.runs[0].session?.label, "run-42/session.jsonl");
	assert.deepEqual(
		analysis.subagents.runs[0].artifacts.map((artifact) => artifact.label),
		["run-42/metadata.json", "run-42/output.md"],
	);
	assert.deepEqual(analysis.references.intercomTargets, ["subagent-chat-123"]);
	assert.deepEqual(
		analysis.references.sessions.map((reference) => reference.label),
		["run-42/session.jsonl"],
	);

	const serialized = JSON.stringify(analysis);
	assert.doesNotMatch(serialized, /SECRET USER PROMPT/);
	assert.doesNotMatch(serialized, /RAW TOOL OUTPUT/);
	assert.doesNotMatch(serialized, /RAW SUBAGENT TASK/);
	assert.doesNotMatch(serialized, /raw scratchpad/);
	assert.doesNotMatch(serialized, /\/Users\/me/);
});

test("analyzeSessionEntries prefers nested pi-subagents foreground results over the parent details container", () => {
	const entries = [
		assistantEntry("a1", null, "2026-06-15T12:30:00Z", {
			stopReason: "tool_use",
			content: [{ type: "toolCall", id: "call-subagent-1", name: "subagent", arguments: { task: "RAW SUBAGENT TASK" } }],
			usage: usage({ input: 40, output: 10, cost: 0.11 }),
		}),
		toolResultEntry(
			"tr1",
			"a1",
			"2026-06-15T12:30:05Z",
			"subagent",
			{
				mode: "parallel",
				runId: "run-77",
				results: [
					{
						agent: "researcher",
						model: "openai-codex/gpt-5.4-mini",
						usage: usage({ input: 20, output: 5, cacheRead: 2, cost: 0.05, turns: 1, assistantMessages: 1 }),
						sessionFile: "/Users/me/.the-last-harness/agent/sessions/--repo--/run-77/researcher.jsonl",
						artifactPaths: {
							outputPath: "/Users/me/.the-last-harness/agent/artifacts/run-77/research.md",
						},
					},
					{
						agent: "developer",
						model: "openai-codex/gpt-5.4",
						usage: usage({ input: 30, output: 7, cacheWrite: 1, cost: 0.08, turns: 1, assistantMessages: 1 }),
						sessionFile: "/Users/me/.the-last-harness/agent/sessions/--repo--/run-77/developer.jsonl",
						artifactPaths: {
							outputPath: "/Users/me/.the-last-harness/agent/artifacts/run-77/implementation.md",
							metadataPath: "/Users/me/.the-last-harness/agent/artifacts/run-77/metadata.json",
						},
					},
				],
				output: "raw parent result payload",
			},
			false,
			"RAW FOREGROUND SUBAGENT RESULT",
		),
	];

	const analysis = analyzeSessionEntries(entries, { toolCatalog });

	assert.equal(analysis.primaryAssistant.timeline[0].discoveries.subagentRuns, 2);
	assert.equal(analysis.subagents.runCount, 2);
	assert.deepEqual(
		analysis.subagents.runs.map((run) => ({ agent: run.agent, mode: run.mode, runId: run.runId, session: run.session?.label })),
		[
			{ agent: "developer", mode: "parallel", runId: "run-77", session: "run-77/developer.jsonl" },
			{ agent: "researcher", mode: "parallel", runId: "run-77", session: "run-77/researcher.jsonl" },
		],
	);
	assert.deepEqual(analysis.totals.subagents, {
		inputTokens: 50,
		outputTokens: 12,
		cacheReadTokens: 2,
		cacheWriteTokens: 1,
		totalTokens: 65,
		costUsd: 0.13,
		turns: 2,
		assistantMessages: 2,
	});
	assert.deepEqual(
		analysis.references.sessions.map((reference) => reference.label),
		["run-77/developer.jsonl", "run-77/researcher.jsonl"],
	);
	assert.deepEqual(
		analysis.references.artifacts.map((reference) => reference.label),
		["run-77/implementation.md", "run-77/metadata.json", "run-77/research.md"],
	);

	const serialized = JSON.stringify(analysis);
	assert.doesNotMatch(serialized, /RAW FOREGROUND SUBAGENT RESULT/);
	assert.doesNotMatch(serialized, /raw parent result payload/);
	assert.doesNotMatch(serialized, /\/Users\/me/);
});

test("analyzeCurrentSessionUsage reads session metadata and avoids false subagent discoveries from ordinary tool details", () => {
	const entries = [
		assistantEntry("a1", null, "2026-06-15T13:00:00Z", {
			content: [{ type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "pwd" } }],
		}),
		toolResultEntry("tr1", "a1", "2026-06-15T13:00:01Z", "bash", { exitCode: 0, cwd: "/tmp/private" }, false, "pwd output"),
	];
	const sessionManager = {
		getEntries: () => entries,
		getHeader: () => ({ id: "session-2", timestamp: "2026-06-15T13:00:00Z" }),
		getLeafId: () => "tr1",
		getSessionName: () => "Shell only",
	};

	const analysis = analyzeCurrentSessionUsage(sessionManager, toolCatalog);

	assert.equal(analysis.session.sessionId, "session-2");
	assert.equal(analysis.session.sessionName, "Shell only");
	assert.equal(analysis.primaryAssistant.usageCoverage.withoutUsage, 1);
	assert.equal(analysis.subagents.runCount, 0);
	assert.equal(analysis.references.sessions.length, 0);
	assert.equal(analysis.references.artifacts.length, 0);
});

test("subagents.byAgent groups runs by agent+provider and sums usage across multiple agents", () => {
	// Use separate tool-result entries so each run gets a distinct sourceEntryId
	// (avoiding key collisions in the subagentRuns deduplication map).
	const entries = [
		assistantEntry("a1", null, "2026-06-15T15:00:00Z", {
			stopReason: "tool_use",
			content: [
				{ type: "toolCall", id: "call-sub-1", name: "subagent", arguments: { task: "task" } },
				{ type: "toolCall", id: "call-sub-2", name: "subagent", arguments: { task: "task" } },
				{ type: "toolCall", id: "call-sub-3", name: "subagent", arguments: { task: "task" } },
			],
			usage: usage({ input: 50, output: 10, cost: 0.1 }),
		}),
		// researcher run 1 (distinct entry id → distinct subagentRun key)
		toolResultEntry(
			"tr1",
			"a1",
			"2026-06-15T15:00:05Z",
			"subagent",
			{
				agent: "researcher",
				model: "anthropic/claude-sonnet-4",
				usage: usage({ input: 100, output: 20, cost: 0.05, turns: 2, assistantMessages: 2 }),
			},
			false,
			"result",
		),
		// developer run
		toolResultEntry(
			"tr2",
			"a1",
			"2026-06-15T15:00:06Z",
			"subagent",
			{
				agent: "developer",
				model: "anthropic/claude-sonnet-4",
				usage: usage({ input: 200, output: 40, cost: 0.1, turns: 3, assistantMessages: 3 }),
			},
			false,
			"result",
		),
		// researcher run 2 (distinct entry id → unique key, gets summed into researcher group)
		toolResultEntry(
			"tr3",
			"a1",
			"2026-06-15T15:00:07Z",
			"subagent",
			{
				agent: "researcher",
				model: "anthropic/claude-sonnet-4",
				usage: usage({ input: 50, output: 10, cost: 0.025, turns: 1, assistantMessages: 1 }),
			},
			false,
			"result",
		),
	];

	const analysis = analyzeSessionEntries(entries, { toolCatalog });

	assert.equal(analysis.subagents.runCount, 3);
	assert.equal(analysis.subagents.byAgent.length, 2);

	const devEntry = analysis.subagents.byAgent.find((e) => e.agent === "developer");
	const resEntry = analysis.subagents.byAgent.find((e) => e.agent === "researcher");

	assert.ok(devEntry, "developer group should exist");
	assert.equal(devEntry.provider, "anthropic");
	assert.equal(devEntry.usage.inputTokens, 200);
	assert.equal(devEntry.usage.outputTokens, 40);
	assert.equal(devEntry.usage.turns, 3);

	assert.ok(resEntry, "researcher group should exist");
	assert.equal(resEntry.provider, "anthropic");
	// Two researcher runs summed: 100+50=150 input, 20+10=30 output, 2+1=3 turns
	assert.equal(resEntry.usage.inputTokens, 150);
	assert.equal(resEntry.usage.outputTokens, 30);
	assert.equal(resEntry.usage.turns, 3);

	// byAgent sorted alphabetically: developer before researcher
	assert.equal(analysis.subagents.byAgent[0].agent, "developer");
	assert.equal(analysis.subagents.byAgent[1].agent, "researcher");

	// Per-group sums equal the existing subagents total
	const byAgentInputTotal = analysis.subagents.byAgent.reduce((sum, e) => sum + e.usage.inputTokens, 0);
	assert.equal(byAgentInputTotal, analysis.subagents.usage.inputTokens);
});

test("subagents.byAgent splits one agent across two providers into separate groups", () => {
	const entries = [
		assistantEntry("a1", null, "2026-06-15T16:00:00Z", {
			stopReason: "tool_use",
			content: [
				{ type: "toolCall", id: "call-sub-1", name: "subagent", arguments: { task: "task" } },
			],
			usage: usage({ input: 10, output: 2, cost: 0.01 }),
		}),
		toolResultEntry(
			"tr1",
			"a1",
			"2026-06-15T16:00:05Z",
			"subagent",
			{
				mode: "parallel",
				results: [
					{
						agent: "developer",
						model: "anthropic/claude-sonnet-4",
						usage: usage({ input: 80, output: 15, cost: 0.04, turns: 1, assistantMessages: 1 }),
					},
					{
						agent: "developer",
						model: "openai/gpt-4o",
						usage: usage({ input: 60, output: 10, cost: 0.03, turns: 1, assistantMessages: 1 }),
					},
				],
			},
			false,
			"result",
		),
	];

	const analysis = analyzeSessionEntries(entries, { toolCatalog });

	assert.equal(analysis.subagents.byAgent.length, 2);

	// Both entries are for "developer" but different providers
	const anthropicEntry = analysis.subagents.byAgent.find(
		(e) => e.agent === "developer" && e.provider === "anthropic",
	);
	const openaiEntry = analysis.subagents.byAgent.find(
		(e) => e.agent === "developer" && e.provider === "openai",
	);

	assert.ok(anthropicEntry, "developer:anthropic group should exist");
	assert.equal(anthropicEntry.usage.inputTokens, 80);

	assert.ok(openaiEntry, "developer:openai group should exist");
	assert.equal(openaiEntry.usage.inputTokens, 60);

	// anthropic sorts before openai
	assert.equal(analysis.subagents.byAgent[0].provider, "anthropic");
	assert.equal(analysis.subagents.byAgent[1].provider, "openai");

	// Per-group sums equal the existing subagents total
	const byAgentInputTotal = analysis.subagents.byAgent.reduce((sum, e) => sum + e.usage.inputTokens, 0);
	assert.equal(byAgentInputTotal, analysis.subagents.usage.inputTokens);
});

test("subagents.byAgent excludes runs missing usage and does not affect total", () => {
	const entries = [
		assistantEntry("a1", null, "2026-06-15T17:00:00Z", {
			stopReason: "tool_use",
			content: [
				{ type: "toolCall", id: "call-sub-1", name: "subagent", arguments: { task: "task" } },
			],
			usage: usage({ input: 10, output: 2, cost: 0.01 }),
		}),
		toolResultEntry(
			"tr1",
			"a1",
			"2026-06-15T17:00:05Z",
			"subagent",
			{
				mode: "parallel",
				results: [
					{
						agent: "researcher",
						model: "anthropic/claude-sonnet-4",
						usage: usage({ input: 90, output: 18, cost: 0.045, turns: 1, assistantMessages: 1 }),
					},
					{
						// No usage field — should not appear in byAgent
						agent: "reviewer",
						model: "anthropic/claude-sonnet-4",
						sessionFile: "/tmp/run-99/reviewer.jsonl",
					},
				],
			},
			false,
			"result",
		),
	];

	const analysis = analyzeSessionEntries(entries, { toolCatalog });

	// Two runs discovered, but only one has usage
	assert.equal(analysis.subagents.runCount, 2);
	assert.equal(analysis.subagents.byAgent.length, 1);
	assert.equal(analysis.subagents.byAgent[0].agent, "researcher");
	assert.equal(analysis.subagents.byAgent[0].usage.inputTokens, 90);

	// byAgent total matches subagents usage total (only runs with usage contribute)
	const byAgentInputTotal = analysis.subagents.byAgent.reduce((sum, e) => sum + e.usage.inputTokens, 0);
	assert.equal(byAgentInputTotal, analysis.subagents.usage.inputTokens);
});

test("direct MCP tools count toward estimated MCP attribution when the current tool catalog identifies them", () => {
	const entries = [
		assistantEntry("a1", null, "2026-06-15T14:00:00Z", {
			stopReason: "tool_use",
			content: [{ type: "toolCall", id: "call-exa-1", name: "exa_search", arguments: { query: "secret" } }],
			usage: usage({ input: 20, output: 5, cost: 0.05 }),
		}),
	];

	const analysis = analyzeSessionEntries(entries, { toolCatalog });

	assert.equal(analysis.tools.totalCalls, 1);
	assert.equal(analysis.tools.mcpCalls, 1);
	assert.equal(analysis.tools.mcpDirectCalls, 1);
	assert.equal(analysis.tools.byTool[0]?.source.kind, "mcp-direct");
	assert.equal(analysis.tools.bySource[0]?.source.kind, "mcp-direct");
});

test("discovery traversal tolerates cycles and processes the exact depth without reading its children", () => {
	const root = { cycle: null };
	root.cycle = root;
	let current = root;
	for (let depth = 1; depth <= 7; depth += 1) {
		current.next = depth === 7
			? {
				agent: "developer",
				sessionFile: "/Users/me/.the-last-harness/agent/sessions/--repo--/run-depth/within.jsonl",
			}
			: {};
		current = current.next;
	}
	Object.defineProperty(current, "deeper", {
		enumerable: true,
		get() {
			throw new Error("exact-depth child should not be read");
		},
	});

	const analysis = analyzeSingleSubagentResult(root);

	assert.equal(analysis.subagents.runCount, 1);
	assert.deepEqual(
		analysis.references.sessions.map((reference) => reference.label),
		["run-depth/within.jsonl"],
	);
});

test("self- and cross-referential arrays are read once per edge with cycle dedupe", () => {
	let edgeReads = 0;
	const left = new Array(2);
	const right = new Array(2);
	for (const [array, edges] of [
		[left, [left, right]],
		[right, [right, left]],
	]) {
		for (const [index, edge] of edges.entries()) {
			Object.defineProperty(array, index, {
				enumerable: true,
				get() {
					edgeReads += 1;
					return edge;
				},
			});
		}
	}

	const analysis = analyzeSingleSubagentResult({
		branches: left,
		artifactPath: "/Users/me/.the-last-harness/agent/artifacts/run-array-cycles/finished.md",
	});

	assert.deepEqual(
		analysis.references.artifacts.map((reference) => reference.label),
		["run-array-cycles/finished.md"],
	);
	assert.equal(edgeReads, 4);
});

test("preferred results and steps arrays keep their exact independent fast-path bounds", () => {
	for (const key of ["results", "steps"]) {
		const nested = Array.from({ length: 64 }, (_, index) => ({
			agent: `${key}-agent-${index}`,
			sessionFile: `/Users/me/.the-last-harness/agent/sessions/--repo--/run-${key}/${key}-agent-${index}.jsonl`,
		}));
		Object.defineProperty(nested, "64", {
			enumerable: true,
			get() {
				throw new Error(`${key}[64] should not be read`);
			},
		});
		nested.length = 65;

		const analysis = analyzeSingleSubagentResult({ mode: "parallel", [key]: nested });

		assert.equal(analysis.subagents.runCount, 64);
		assert.ok(analysis.subagents.runs.some((run) => run.agent === `${key}-agent-63`));
		assert.ok(!analysis.subagents.runs.some((run) => run.agent === `${key}-agent-64`));
	}
});

test("discovery traversal keeps the exact object-property boundary and does not touch later getters", () => {
	const details = {
		within: {
			artifactPath: "/Users/me/.the-last-harness/agent/artifacts/run-props/within.md",
		},
	};
	for (let index = 1; index < 64; index += 1) {
		details[`filler${index}`] = index;
	}
	Object.defineProperty(details, "overflow", {
		enumerable: true,
		get() {
			throw new Error("overflow property should not be read");
		},
	});

	const analysis = analyzeSingleSubagentResult(details);

	assert.deepEqual(
		analysis.references.artifacts.map((reference) => reference.label),
		["run-props/within.md"],
	);
});

test("discovery traversal caps inherited for-in enumeration work at the same exact boundary", () => {
	const prototype = {};
	for (let index = 0; index < 4; index += 1) {
		prototype[`inherited${index}`] = index;
	}
	const details = Object.create(prototype);
	details.within = {
		artifactPath: "/Users/me/.the-last-harness/agent/artifacts/run-prototype/within.md",
	};
	for (let index = 1; index < 63; index += 1) {
		details[`filler${index}`] = index;
	}

	const originalHasOwn = Object.hasOwn;
	let detailHasOwnCalls = 0;
	Object.hasOwn = function patchedHasOwn(target, key) {
		if (target === details) {
			detailHasOwnCalls += 1;
			if (detailHasOwnCalls > 64) {
				throw new Error(`prototype traversal exceeded boundary at ${String(key)}`);
			}
		}
		return originalHasOwn(target, key);
	};

	try {
		const analysis = analyzeSingleSubagentResult(details);

		assert.equal(detailHasOwnCalls, 64);
		assert.deepEqual(
			analysis.references.artifacts.map((reference) => reference.label),
			["run-prototype/within.md"],
		);
	} finally {
		Object.hasOwn = originalHasOwn;
	}
});

test("discovery traversal keeps exact attemptedModels and agents boundaries", () => {
	const attemptedModels = Array.from({ length: 64 }, (_, index) => `provider/model-${index}`);
	Object.defineProperty(attemptedModels, "64", {
		enumerable: true,
		get() {
			throw new Error("attemptedModels[64] should not be read");
		},
	});
	attemptedModels.length = 65;

	const agents = Array.from({ length: 64 }, (_, index) => `agent-${index}`);
	Object.defineProperty(agents, "64", {
		enumerable: true,
		get() {
			throw new Error("agents[64] should not be read");
		},
	});
	agents.length = 65;

	const analysis = analyzeSingleSubagentResult({
		agent: "developer",
		sessionFile: "/Users/me/.the-last-harness/agent/sessions/--repo--/run-strings/developer.jsonl",
		attemptedModels,
		agents,
	});
	const run = analysis.subagents.runs[0];

	assert.equal(run.attemptedModels.length, 64);
	assert.equal(run.attemptedModels.at(-1), "provider/model-63");
	assert.equal(run.agents.length, 65);
	assert.equal(run.agents[0], "developer");
	assert.equal(run.agents.at(-1), "agent-63");
});

test("artifactPaths keeps array and object-map compatibility while enforcing the exact boundary", () => {
	for (const { form, createArtifactPaths } of [
		{
			form: "array",
			createArtifactPaths: (paths) => [...paths],
		},
		{
			form: "object-map",
			createArtifactPaths: (paths) => Object.fromEntries(paths.map((path, index) => [`path${index}`, path])),
		},
	]) {
		const runId = `run-${form}-paths`;
		const paths = Array.from(
			{ length: 64 },
			(_, index) => `/Users/me/.the-last-harness/agent/artifacts/${runId}/artifact-${index}.md`,
		);
		const artifactPaths = createArtifactPaths(paths);
		const overflowKey = Array.isArray(artifactPaths) ? "64" : "overflow";
		Object.defineProperty(artifactPaths, overflowKey, {
			enumerable: true,
			get() {
				throw new Error(`${form} artifactPaths entry past the boundary should not be read`);
			},
		});
		if (Array.isArray(artifactPaths)) {
			artifactPaths.length = 65;
		}

		const analysis = analyzeSingleSubagentResult({ agent: "developer", artifactPaths });
		const labels = analysis.references.artifacts.map((reference) => reference.label);

		assert.equal(labels.length, 64, `${form} should retain exactly 64 artifact paths`);
		assert.ok(labels.includes(`${runId}/artifact-0.md`));
		assert.ok(labels.includes(`${runId}/artifact-63.md`));
	}
});

test("discovery traversal processes the exact container-budget boundary without reading another child", () => {
	const groups = [];
	for (let groupIndex = 0; groupIndex < 8; groupIndex += 1) {
		const items = [];
		for (let itemIndex = 0; itemIndex < 64; itemIndex += 1) {
			items.push({ note: `${groupIndex}:${itemIndex}` });
		}
		groups.push({ items });
	}
	const boundaryItem = groups[7].items[44];
	boundaryItem.artifactPath = "/Users/me/.the-last-harness/agent/artifacts/run-objects/included.md";
	Object.defineProperty(boundaryItem, "child", {
		enumerable: true,
		get() {
			throw new Error("exact-budget child property should not be read");
		},
	});
	Object.defineProperty(groups[7].items, "45", {
		enumerable: true,
		get() {
			throw new Error("array index after the container budget should not be read");
		},
	});

	const analysis = analyzeSingleSubagentResult({ groups });

	assert.deepEqual(
		analysis.references.artifacts.map((reference) => reference.label),
		["run-objects/included.md"],
	);
});

// ---------------------------------------------------------------------------
// Cache-miss detection tests (ported from pi-coding-agent@0.80.6 core/cache-stats)
// ---------------------------------------------------------------------------

/**
 * Build a raw usage object with explicit per-component costs.
 * The existing `usage()` helper always sets cost.cacheRead/cacheWrite to 0,
 * which is insufficient for cache-miss cost precision tests.
 */
function usageRaw({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0, costInput = 0, costOutput = 0, costCacheRead = 0, costCacheWrite = 0 } = {}) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost: {
			total: costInput + costOutput + costCacheRead + costCacheWrite,
			input: costInput,
			output: costOutput,
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
		},
	};
}

test("cacheMisses: idle-gap miss is detected when the previous context was not served from cache", () => {
	// Turn 0: input=5000, cacheRead=2000 → promptTokens=7000, reportedCache=true
	// Turn 1 (10 min later): input=7000, cacheRead=0
	//   missedTokens = min(7000, 7000) - 0 = 7000 > 1024 → miss
	//   idleMs = 600 000 ms (10 min gap)
	const entries = [
		assistantEntry("a1", null, "2026-07-01T10:00:00.000Z", {
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			usage: usageRaw({ input: 5000, output: 100, cacheRead: 2000, costInput: 0.015, costCacheRead: 0.002 }),
		}),
		assistantEntry("a2", "a1", "2026-07-01T10:10:00.000Z", {
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			usage: usageRaw({ input: 7000, output: 80, costInput: 0.021 }),
		}),
	];

	const analysis = analyzeSessionEntries(entries);

	assert.equal(analysis.cacheMisses.missCount, 1, "should detect one miss");
	assert.equal(analysis.cacheMisses.missedTokens, 7000, "missedTokens = min(7000,7000) - 0");
	assert.equal(analysis.cacheMisses.worst.length, 1);
	assert.equal(analysis.cacheMisses.worst[0].turnIndex, 1, "turnIndex is 0-based; second assistant message = index 1");
	assert.equal(analysis.cacheMisses.worst[0].modelChanged, false);
	// idleMs = 10 min = 600 000 ms
	assert.equal(analysis.cacheMisses.worst[0].idleMs, 600_000);
	// paidPerToken = 0.021/7000 = 0.000003; readPerToken = 0 (no cacheRead, no priceSource)
	// missedCost = 7000 * 0.000003 = 0.021
	assert.ok(
		Math.abs(analysis.cacheMisses.missedCost - 0.021) < 1e-9,
		`missedCost should be ~0.021, got ${analysis.cacheMisses.missedCost}`,
	);
});

test("cacheMisses: model-change miss records modelChanged=true in the worst entry", () => {
	// Turn 0: anthropic/claude-3-5, cacheRead > 0 (reportedCache=true)
	// Turn 1: openai/gpt-4o, cacheRead=0 → miss with modelChanged=true
	const entries = [
		assistantEntry("a1", null, "2026-07-01T11:00:00.000Z", {
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			usage: usageRaw({ input: 4000, cacheRead: 3000, costInput: 0.012, costCacheRead: 0.003 }),
		}),
		assistantEntry("a2", "a1", "2026-07-01T11:01:00.000Z", {
			provider: "openai",
			model: "gpt-4o",
			usage: usageRaw({ input: 7000, costInput: 0.021 }),
		}),
	];

	const analysis = analyzeSessionEntries(entries);

	assert.equal(analysis.cacheMisses.missCount, 1);
	// missedTokens = min(4000+3000, 7000) - 0 = 7000
	assert.equal(analysis.cacheMisses.worst[0].missedTokens, 7000);
	assert.equal(analysis.cacheMisses.worst[0].modelChanged, true, "model switch should be flagged");
	assert.equal(analysis.cacheMisses.worst[0].turnIndex, 1);
});

test("cacheMisses: compaction entry clears the prev baseline so no miss is detected across it", () => {
	// Turn 0: large prompt with cache activity (reportedCache=true)
	// Compaction entry → prev cleared
	// Turn 1: same size, no cacheRead → but prev is undefined, so no miss
	const entries = [
		assistantEntry("a1", null, "2026-07-01T12:00:00.000Z", {
			usage: usageRaw({ input: 5000, cacheRead: 2000 }),
		}),
		{
			type: "compaction",
			id: "comp1",
			parentId: "a1",
			timestamp: "2026-07-01T12:01:00.000Z",
		},
		assistantEntry("a2", "comp1", "2026-07-01T12:02:00.000Z", {
			usage: usageRaw({ input: 7000 }),
		}),
	];

	const analysis = analyzeSessionEntries(entries);

	assert.equal(analysis.cacheMisses.missCount, 0, "compaction should clear prev; no miss across it");
	assert.equal(analysis.cacheMisses.missedTokens, 0);
	assert.equal(analysis.cacheMisses.worst.length, 0);
});

test("cacheMisses: branch_summary entry also clears prev baseline", () => {
	const entries = [
		assistantEntry("a1", null, "2026-07-01T13:00:00.000Z", {
			usage: usageRaw({ input: 5000, cacheRead: 2000 }),
		}),
		{
			type: "branch_summary",
			id: "bs1",
			parentId: "a1",
			timestamp: "2026-07-01T13:01:00.000Z",
		},
		assistantEntry("a2", "bs1", "2026-07-01T13:02:00.000Z", {
			usage: usageRaw({ input: 7000 }),
		}),
	];

	const analysis = analyzeSessionEntries(entries);

	assert.equal(analysis.cacheMisses.missCount, 0, "branch_summary should clear prev; no miss across it");
});

test("cacheMisses: correctly ignores a miss when missedTokens does not exceed noise floor of 1024", () => {
	// prev.promptTokens = 5000 (input=3000, cacheRead=2000)
	// curr: input=3000, cacheRead=4500, promptTokens=7500
	//   missedTokens = min(5000, 7500) - 4500 = 5000 - 4500 = 500 ≤ 1024 → ignored
	const entries = [
		assistantEntry("a1", null, "2026-07-01T15:00:00.000Z", {
			usage: usageRaw({ input: 3000, cacheRead: 2000 }),
		}),
		assistantEntry("a2", "a1", "2026-07-01T15:01:00.000Z", {
			usage: usageRaw({ input: 3000, cacheRead: 4500 }),
		}),
	];

	const analysis = analyzeSessionEntries(entries);

	assert.equal(analysis.cacheMisses.missCount, 0, "missedTokens=500 is at or below noise floor");
	assert.equal(analysis.cacheMisses.missedTokens, 0);
});

test("cacheMisses: first-turn has no prev so it produces no miss", () => {
	const entries = [
		assistantEntry("a1", null, "2026-07-01T16:00:00.000Z", {
			usage: usageRaw({ input: 8000, cacheRead: 0 }),
		}),
	];

	const analysis = analyzeSessionEntries(entries);

	assert.equal(analysis.cacheMisses.missCount, 0, "no prev → no miss on first turn");
});

test("cacheMisses: two turns with no cache activity ever are not flagged (no-cache provider skip)", () => {
	// cacheRead+cacheWrite==0 on Turn 1, and prev.reportedCache==false → skip Turn 2.
	const entries = [
		assistantEntry("a1", null, "2026-07-01T16:30:00.000Z", {
			usage: usageRaw({ input: 8000 }), // no cacheRead/cacheWrite → reportedCache=false
		}),
		assistantEntry("a2", "a1", "2026-07-01T16:31:00.000Z", {
			usage: usageRaw({ input: 8000 }), // no cacheRead/cacheWrite AND prev.reportedCache==false → skip
		}),
	];

	const analysis = analyzeSessionEntries(entries);

	assert.equal(analysis.cacheMisses.missCount, 0, "no-cache provider: skip when cacheRead+cacheWrite==0 and prev never reported cache");
});

test("cacheMisses: modelRegistry-absent means readPerToken falls back to 0 (cost computed without cache-read discount)", () => {
	// Turn 0: cacheRead=2000 → reportedCache=true
	// Turn 1: cacheRead=0, no priceSource → readPerToken=0
	//   paidTokens=6000, paidPerToken = 0.018/6000 = 0.000003
	//   missedCost = 5000 * max(0, 0.000003 - 0) = 0.015
	const entries = [
		assistantEntry("a1", null, "2026-07-01T17:00:00.000Z", {
			usage: usageRaw({ input: 3000, cacheRead: 2000, costInput: 0.009, costCacheRead: 0.002 }),
		}),
		assistantEntry("a2", "a1", "2026-07-01T17:01:00.000Z", {
			// prev.promptTokens = 3000+2000 = 5000
			// curr.promptTokens = 6000+0 = 6000
			// missedTokens = min(5000, 6000) - 0 = 5000 > 1024 → miss
			// paidPerToken = 0.018/6000 = 0.000003
			// readPerToken = 0 (no cacheRead, no priceSource)
			// missedCost = 5000 * 0.000003 = 0.015
			usage: usageRaw({ input: 6000, costInput: 0.018 }),
		}),
	];

	// analyzeSessionEntries without priceSource (absent = fallback to 0)
	const analysis = analyzeSessionEntries(entries);

	assert.equal(analysis.cacheMisses.missCount, 1);
	assert.equal(analysis.cacheMisses.missedTokens, 5000);
	assert.ok(
		Math.abs(analysis.cacheMisses.missedCost - 0.015) < 1e-9,
		`missedCost should be ~0.015 (read-rate 0 fallback), got ${analysis.cacheMisses.missedCost}`,
	);

	// With a modelRegistry that returns a cacheRead price, the discount is applied.
	const mockRegistry = {
		find(_provider, _modelId) {
			return { cost: { cacheRead: 0.3 } }; // 0.3 per million tokens
		},
	};
	const analysisWithRegistry = analyzeSessionEntries(entries, { priceSource: mockRegistry });
	// readPerToken = 0.3/1_000_000 = 0.0000003
	// missedCost = 5000 * max(0, 0.000003 - 0.0000003) = 5000 * 0.0000027 = 0.0135
	assert.ok(
		analysisWithRegistry.cacheMisses.missedCost < analysis.cacheMisses.missedCost,
		"with a priceSource, the cache-read discount reduces missedCost",
	);
	assert.ok(
		Math.abs(analysisWithRegistry.cacheMisses.missedCost - 0.0135) < 1e-9,
		`missedCost with registry should be ~0.0135, got ${analysisWithRegistry.cacheMisses.missedCost}`,
	);
});

test("cacheMisses: worst list is sorted by missedTokens descending and capped at 10", () => {
	// Create 12 assistant messages alternating between large cache and zero cache,
	// so 11 misses of varying sizes occur. worst should show only top 10.
	const entries = [];
	const sizes = [10000, 5000, 9000, 3000, 8000, 2000, 7000, 1500, 6000, 1200, 4000];
	// sizes[0] is the baseline (cacheRead > 0 → reportedCache=true), then each subsequent
	// entry has cacheRead=0 creating a miss. The missedTokens for miss i is min(prev, curr).
	// To get predictably different miss sizes, alternate: large context → zero cache.
	let parentId = null;
	let timestamp = Date.parse("2026-07-01T18:00:00.000Z");
	for (let i = 0; i < sizes.length; i++) {
		const id = `a${i}`;
		const isBaseline = i === 0;
		entries.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(timestamp).toISOString(),
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-3-5-sonnet",
				usage: usageRaw({
					input: sizes[i],
					cacheRead: isBaseline ? 5000 : 0,
					costInput: 0.001,
				}),
			},
		});
		parentId = id;
		timestamp += 60_000;
	}

	const analysis = analyzeSessionEntries(entries);

	// Should have detected misses for turns 1..10 (10 miss events), worst capped at 10
	assert.ok(analysis.cacheMisses.missCount >= 10, `expected >=10 misses, got ${analysis.cacheMisses.missCount}`);
	assert.equal(analysis.cacheMisses.worst.length, Math.min(analysis.cacheMisses.missCount, 10), "worst capped at 10");

	// Verify descending order
	for (let i = 1; i < analysis.cacheMisses.worst.length; i++) {
		assert.ok(
			analysis.cacheMisses.worst[i - 1].missedTokens >= analysis.cacheMisses.worst[i].missedTokens,
			`worst[${i - 1}].missedTokens should be >= worst[${i}].missedTokens`,
		);
	}
});

test("cacheMisses: cacheReadInputTokens/cacheWriteInputTokens aliases produce same miss detection as cacheRead/cacheWrite", () => {
	// Regression for tlhmo-y445: the cache-miss path must recognise the
	// cacheReadInputTokens / cacheWriteInputTokens camelCase aliases, matching
	// the precedence normalizeUsage already uses.

	// Baseline turn uses the canonical cacheRead/cacheWrite keys.
	// Miss turn uses the cacheReadInputTokens/cacheWriteInputTokens aliases.
	// If the aliases are ignored, cmCacheRead stays 0 and miss detection breaks.
	const entriesAlias = [
		// Turn 0: seed cache activity so prev.reportedCache=true.
		// Use canonical cacheRead key here (baseline).
		assistantEntry("a1", null, "2026-07-12T10:00:00.000Z", {
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			usage: {
				input: 5000,
				output: 100,
				cacheReadInputTokens: 2000,
				cacheWriteInputTokens: 500,
			},
		}),
		// Turn 1: no cache → miss. Uses cacheReadInputTokens=0 (absent = 0).
		assistantEntry("a2", "a1", "2026-07-12T10:10:00.000Z", {
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			usage: {
				input: 7500,
				output: 80,
				// No cacheReadInputTokens / cacheWriteInputTokens → miss
			},
		}),
	];

	// Equivalent entries using the canonical cacheRead/cacheWrite keys (reference).
	const entriesCanonical = [
		assistantEntry("a1", null, "2026-07-12T10:00:00.000Z", {
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			usage: {
				input: 5000,
				output: 100,
				cacheRead: 2000,
				cacheWrite: 500,
			},
		}),
		assistantEntry("a2", "a1", "2026-07-12T10:10:00.000Z", {
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			usage: {
				input: 7500,
				output: 80,
			},
		}),
	];

	const aliasAnalysis = analyzeSessionEntries(entriesAlias);
	const canonicalAnalysis = analyzeSessionEntries(entriesCanonical);

	// Both should detect exactly 1 miss.
	assert.equal(aliasAnalysis.cacheMisses.missCount, 1,
		"cacheReadInputTokens/cacheWriteInputTokens aliases: should detect 1 miss");
	assert.equal(aliasAnalysis.cacheMisses.missCount, canonicalAnalysis.cacheMisses.missCount,
		"alias and canonical keys must produce the same missCount");
	assert.equal(aliasAnalysis.cacheMisses.missedTokens, canonicalAnalysis.cacheMisses.missedTokens,
		"alias and canonical keys must produce the same missedTokens");

	// Turn 0 baseline: promptTokens = 5000 + 2000 + 500 = 7500; reportedCache = true.
	// Turn 1: promptTokens = 7500; cacheRead = 0.
	// missedTokens = min(7500, 7500) - 0 = 7500.
	assert.equal(aliasAnalysis.cacheMisses.missedTokens, 7500,
		"missedTokens should be 7500 when cacheReadInputTokens/cacheWriteInputTokens are read correctly");
});

test("cacheMisses: analyzeCurrentSessionUsage accepts optional priceSource and forwards it", () => {
	const entries = [
		assistantEntry("a1", null, "2026-07-01T19:00:00.000Z", {
			usage: usageRaw({ input: 5000, cacheRead: 2000 }),
		}),
		assistantEntry("a2", "a1", "2026-07-01T19:01:00.000Z", {
			usage: usageRaw({ input: 7000, costInput: 0.021 }),
		}),
	];

	const sessionManager = {
		getEntries: () => entries,
		getHeader: () => ({ id: "sess-cm", timestamp: "2026-07-01T19:00:00.000Z" }),
		getLeafId: () => "a2",
		getSessionName: () => "Cache miss test",
	};

	// Without priceSource: readPerToken = 0
	const analysisWithout = analyzeCurrentSessionUsage(sessionManager, []);
	assert.equal(analysisWithout.cacheMisses.missCount, 1);

	const registry = {
		find(_provider, _model) {
			return { cost: { cacheRead: 0.3 } };
		},
	};

	// With priceSource (passed as third arg): discount applied
	const analysisWith = analyzeCurrentSessionUsage(sessionManager, [], registry);
	assert.equal(analysisWith.cacheMisses.missCount, 1);
	assert.ok(
		analysisWith.cacheMisses.missedCost <= analysisWithout.cacheMisses.missedCost,
		"priceSource with non-zero cacheRead rate should not increase missedCost",
	);
});

// ---------------------------------------------------------------------------
// observedLatency tests (ts-j1k4)
// ---------------------------------------------------------------------------

test("analyzeSessionEntries populates observedLatency on byTool entries when toolCallIds match, and does not change token or cost values", () => {
	// Entries where call-side toolCallId matches result-side toolCallId.
	// bash: result at +2s (2000ms). read: result at +15s (15000ms).
	const entries = [
		userEntry("u1", null, "2026-07-10T10:00:00.000Z", "user prompt"),
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-07-10T10:00:10.000Z",
			message: {
				role: "assistant",
				provider: "openai",
				model: "gpt-5",
				stopReason: "tool_use",
				content: [
					{ type: "toolCall", toolCallId: "tc-bash-1", name: "bash", arguments: { command: "echo hi" } },
					{ type: "toolCall", toolCallId: "tc-read-1", name: "read", arguments: { path: "/tmp/file" } },
				],
				usage: usage({ input: 100, output: 20, cost: 0.3 }),
			},
		},
		{
			type: "message",
			id: "tr1",
			parentId: "a1",
			timestamp: "2026-07-10T10:00:12.000Z",
			message: {
				role: "toolResult",
				toolName: "bash",
				toolCallId: "tc-bash-1",
				isError: false,
				content: [{ type: "text", text: "hi" }],
			},
		},
		{
			type: "message",
			id: "tr2",
			parentId: "a1",
			timestamp: "2026-07-10T10:00:25.000Z",
			message: {
				role: "toolResult",
				toolName: "read",
				toolCallId: "tc-read-1",
				isError: false,
				content: [{ type: "text", text: "file content" }],
			},
		},
		assistantEntry("a2", "tr2", "2026-07-10T10:00:30.000Z", {
			text: "Done.",
			usage: usage({ input: 50, output: 10, cost: 0.1 }),
		}),
	];

	const analysis = analyzeSessionEntries(entries, { activeLeafId: "a2" });

	// Token and cost values must not change as a result of adding latency.
	assert.equal(analysis.totals.primary.totalTokens, 180, "primary totalTokens unchanged");
	assert.equal(analysis.totals.primary.inputTokens, 150, "primary inputTokens unchanged");
	assert.equal(analysis.totals.primary.outputTokens, 30, "primary outputTokens unchanged");
	assert.ok(Math.abs(analysis.totals.primary.costUsd - 0.4) < 1e-9, "primary costUsd unchanged");

	// bash should have a 2000ms observed latency.
	const bashTool = analysis.tools.byTool.find((t) => t.toolName === "bash");
	assert.ok(bashTool, "bash tool present in byTool");
	assert.ok(bashTool.observedLatency, "bash tool has observedLatency");
	assert.equal(bashTool.observedLatency.pairedCount, 1, "bash: 1 paired call");
	assert.equal(bashTool.observedLatency.medianMs, 2000, "bash: median 2000ms");
	assert.equal(bashTool.observedLatency.maxMs, 2000, "bash: max 2000ms");

	// read should have a 15000ms observed latency.
	const readTool = analysis.tools.byTool.find((t) => t.toolName === "read");
	assert.ok(readTool, "read tool present in byTool");
	assert.ok(readTool.observedLatency, "read tool has observedLatency");
	assert.equal(readTool.observedLatency.pairedCount, 1, "read: 1 paired call");
	assert.equal(readTool.observedLatency.medianMs, 15000, "read: median 15000ms");
	assert.equal(readTool.observedLatency.maxMs, 15000, "read: max 15000ms");
});

test("analyzeSessionEntries computes median observedLatency correctly across multiple pairs for the same tool", () => {
	// Three bash calls from the same assistant turn:
	// tc1 result at +1s (1000ms), tc2 at +3s (3000ms), tc3 at +5s (5000ms).
	// Sorted: [1000, 3000, 5000] → median at floor((3-1)/2)=1 → 3000ms.
	const entries = [
		userEntry("u1", null, "2026-07-10T11:00:00.000Z", "user prompt"),
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-07-10T11:00:00.000Z",
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-4",
				stopReason: "tool_use",
				content: [
					{ type: "toolCall", toolCallId: "tc1", name: "bash", arguments: { command: "echo 1" } },
					{ type: "toolCall", toolCallId: "tc2", name: "bash", arguments: { command: "echo 2" } },
					{ type: "toolCall", toolCallId: "tc3", name: "bash", arguments: { command: "echo 3" } },
				],
				usage: usage({ input: 100, output: 10, cost: 0.2 }),
			},
		},
		{
			type: "message",
			id: "tr1",
			parentId: "a1",
			timestamp: "2026-07-10T11:00:01.000Z",
			message: { role: "toolResult", toolName: "bash", toolCallId: "tc1", isError: false, content: [{ type: "text", text: "1" }] },
		},
		{
			type: "message",
			id: "tr2",
			parentId: "a1",
			timestamp: "2026-07-10T11:00:03.000Z",
			message: { role: "toolResult", toolName: "bash", toolCallId: "tc2", isError: false, content: [{ type: "text", text: "2" }] },
		},
		{
			type: "message",
			id: "tr3",
			parentId: "a1",
			timestamp: "2026-07-10T11:00:05.000Z",
			message: { role: "toolResult", toolName: "bash", toolCallId: "tc3", isError: false, content: [{ type: "text", text: "3" }] },
		},
		assistantEntry("a2", "tr3", "2026-07-10T11:00:10.000Z", { text: "done.", usage: usage({ input: 50, output: 5, cost: 0.1 }) }),
	];

	const analysis = analyzeSessionEntries(entries, { activeLeafId: "a2" });
	const bashTool = analysis.tools.byTool.find((t) => t.toolName === "bash");
	assert.ok(bashTool?.observedLatency, "bash tool has observedLatency");
	assert.equal(bashTool.observedLatency.pairedCount, 3, "3 paired calls");
	assert.equal(bashTool.observedLatency.medianMs, 3000, "median is middle value (3000ms)");
	assert.equal(bashTool.observedLatency.maxMs, 5000, "max is largest value (5000ms)");
});

test("analyzeSessionEntries leaves observedLatency absent when no toolCallId pairs match", () => {
	// The standard toolResultEntry helper uses mismatched IDs (${id}-call vs the call's id),
	// so pairToolCalls finds no pairs. observedLatency must be absent in that case.
	const entries = [
		assistantEntry("a1", null, "2026-07-10T12:00:00.000Z", {
			stopReason: "tool_use",
			content: [{ type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "ls" } }],
			usage: usage({ input: 50, output: 5, cost: 0.1 }),
		}),
		toolResultEntry("tr1", "a1", "2026-07-10T12:00:01.000Z", "bash", {}, false, "ok"),
		assistantEntry("a2", "tr1", "2026-07-10T12:00:05.000Z", { text: "done.", usage: usage({ input: 30, output: 5, cost: 0.05 }) }),
	];
	const analysis = analyzeSessionEntries(entries, { activeLeafId: "a2" });
	const bashTool = analysis.tools.byTool.find((t) => t.toolName === "bash");
	assert.ok(bashTool, "bash tool is present");
	assert.equal(bashTool.observedLatency, undefined, "observedLatency is absent when no toolCallId pairs match");
	// Token values must still be correct.
	assert.equal(analysis.totals.primary.totalTokens, 90, "totalTokens unchanged");
});
