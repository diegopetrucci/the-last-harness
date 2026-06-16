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
