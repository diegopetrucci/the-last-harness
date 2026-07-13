import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { makeTempDir } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { buildTokensReportHtml, registerTokensCommand } = await jiti.import("../extensions/the-last-harness/tokens.ts");
const { analyzeSessionEntries } = await jiti.import("../extensions/the-last-harness/tokens-analyzer.ts");

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

function createPiHarness(allTools = []) {
	const commands = new Map();
	return {
		commands,
		getAllTools() {
			return allTools;
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};
}

function createCommandContext({ sessionDir, entries }) {
	const notifications = [];
	const sessionFile = join(sessionDir, "session.jsonl");
	return {
		notifications,
		ctx: {
			ui: {
				notify(message, type) {
					notifications.push({ message, type });
				},
			},
			sessionManager: {
				getEntries: () => entries,
				getHeader: () => ({ id: "session-1", timestamp: "2026-06-15T12:00:00Z" }),
				getLeafId: () => "a3",
				getSessionName: () => "Token report",
				getSessionFile: () => sessionFile,
				getSessionDir: () => sessionDir,
			},
		},
	};
}

test("/tokens rejects arguments and preserves the exact single-command surface", async (t) => {
	const pi = createPiHarness();
	let opened = false;
	registerTokensCommand(pi, {
		openReport: async () => {
			opened = true;
		},
	});
	const command = pi.commands.get("tokens");
	assert.ok(command, "registers /tokens");

	const { notifications, ctx } = createCommandContext({ sessionDir: makeTempDir("tlh-tokens-args-", t), entries: [] });
	await command.handler("status now", ctx);

	assert.equal(opened, false);
	assert.deepEqual(notifications, [{ message: "Usage: /tokens", type: "error" }]);
});

test("/tokens writes a private local HTML report from sanitized analyzer output and opens it by default", async (t) => {
	const sessionDir = makeTempDir("tlh-tokens-report-", t);
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
			content: [{ type: "toolCall", id: "call-mcp-1", name: "mcp", arguments: { server: "exa", prompt: "secret query" } }],
			usage: usage({ input: 80, output: 15, cost: 0.25 }),
		}),
		toolResultEntry("tr3", "a2", "2026-06-15T12:00:18Z", "mcp", { server: "exa" }, false, "MCP RAW RESULT"),
		assistantEntry("a3", "tr3", "2026-06-15T12:00:25Z", {
			text: "Done.",
			usage: usage({ input: 60, output: 25, cacheRead: 10, cost: 0.22 }),
		}),
	];
	const toolCatalog = [
		{ name: "bash", sourceInfo: { source: "built-in", path: "core/tools/bash.ts", scope: "user", origin: "top-level" } },
		{ name: "subagent", sourceInfo: { source: "npm:pi-subagents", path: "extensions/subagent.mjs", scope: "user", origin: "package" } },
		{ name: "mcp", sourceInfo: { source: "npm:pi-mcp-adapter", path: "extensions/mcp.mjs", scope: "user", origin: "package" } },
	];
	const pi = createPiHarness(toolCatalog);
	let openedPath;
	registerTokensCommand(pi, {
		openReport: async (path) => {
			openedPath = path;
		},
		now: () => new Date("2026-06-15T12:34:56Z"),
	});
	const command = pi.commands.get("tokens");
	assert.ok(command, "registers /tokens");

	const { notifications, ctx } = createCommandContext({ sessionDir, entries });
	await command.handler("", ctx);

	assert.ok(openedPath, "opens the generated report by default");
	const html = readFileSync(openedPath, "utf8");
	assert.match(html, /<h2>Overview<\/h2>/);
	assert.match(html, /<h2>Timeline<\/h2>/);
	assert.match(html, /<h2>Agents\/subagents<\/h2>/);
	assert.match(html, /<h2>Tools\/MCP<\/h2>/);
	assert.match(html, /<h2>Cache<\/h2>/);
	assert.match(html, /<h2>Caveats<\/h2>/);
	assert.match(html, /run-42\/session\.jsonl/);
	assert.match(html, /run-42\/metadata\.json/);
	assert.doesNotMatch(html, /SECRET USER PROMPT/);
	assert.doesNotMatch(html, /RAW TOOL OUTPUT/);
	assert.doesNotMatch(html, /RAW SUBAGENT TASK/);
	assert.doesNotMatch(html, /RAW SUBAGENT RESULT/);
	assert.doesNotMatch(html, /raw scratchpad/);
	assert.doesNotMatch(html, /secret query/);
	assert.doesNotMatch(html, /\/Users\/me/);
	assert.match(html, /This local report omits raw transcript text, raw tool arguments, and raw tool-result payloads by design\./);
	assert.match(notifications.at(-1)?.message ?? "", /Opened local TLH token report/);
	assert.equal(notifications.at(-1)?.type, "info");

	const reportStat = statSync(openedPath);
	const dirStat = statSync(dirname(openedPath));
	if (process.platform !== "win32") {
		assert.equal(reportStat.mode & 0o777, 0o600);
		assert.equal(dirStat.mode & 0o777, 0o700);
	}
});

test("buildTokensReportHtml escapes dynamic content while preserving required report structure", () => {
	const html = buildTokensReportHtml(
		{
			cacheMisses: { missedTokens: 0, missedCost: 0, missCount: 0, worst: [] },
			session: {
				sessionId: "session-<1>",
				sessionName: "<script>alert(1)</script>",
				startedAt: "2026-06-15T00:00:00Z",
				entryCount: 3,
				leafCount: 1,
				activeLeafId: "leaf",
				assistantTurnsOnActiveBranch: 1,
				assistantTurnsOffActiveBranch: 0,
			},
			totals: {
				primary: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 16, costUsd: 0.04, turns: 1, assistantMessages: 1 },
				subagents: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 1, totalTokens: 4, costUsd: 0.01, turns: 1, assistantMessages: 1 },
				combined: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 1, cacheWriteTokens: 1, totalTokens: 20, costUsd: 0.05, turns: 2, assistantMessages: 2 },
			},
			primaryAssistant: {
				usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 16, costUsd: 0.04, turns: 1, assistantMessages: 1 },
				usageCoverage: { assistantMessages: 1, withUsage: 1, withoutUsage: 0 },
				models: [{ key: "openai/model<unsafe>", provider: "openai", modelId: "model<unsafe>", source: "primary", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 16, costUsd: 0.04, turns: 1, assistantMessages: 1 } }],
				timeline: [
					{
						turnIndex: 1,
						entryId: "a1",
						timestamp: "2026-06-15T00:00:01Z",
						activeBranch: true,
						provider: "openai",
						modelId: "model<unsafe>",
						stopReason: "stop",
						usageReported: true,
						usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 16, costUsd: 0.04, turns: 1, assistantMessages: 1 },
						toolCalls: { total: 1, mcp: 0, byTool: [{ toolName: "tool<script>", count: 1 }] },
						toolResults: { total: 1, errors: 0 },
						discoveries: { subagentRuns: 1, artifactReferences: 1, sessionReferences: 1, intercomTargets: 1 },
					},
				],
			},
			tools: {
				precision: "estimated",
				totalCalls: 1,
				totalResults: 1,
				totalErrors: 0,
				mcpCalls: 0,
				mcpProxyCalls: 0,
				mcpDirectCalls: 0,
				mcpApproxTokens: 0,
				totalToolApproxTokens: 100,
				byTool: [{ toolName: "tool<script>", callCount: 1, resultCount: 1, errorCount: 0, approxTokens: 100, mcp: false, source: { key: "source", label: "Extension <unsafe>", kind: "extension", source: "pkg<unsafe>", estimated: true } }],
				bySource: [{ source: { key: "source", label: "Extension <unsafe>", kind: "extension", source: "pkg<unsafe>", estimated: true }, callCount: 1, approxTokens: 100, tools: ["tool<script>"] }],
			},
			subagents: {
				precision: "discoverable-only",
				runCount: 1,
				usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 1, totalTokens: 4, costUsd: 0.01, turns: 1, assistantMessages: 1 },
				byAgent: [],
				models: [{ key: "sub/model<unsafe>", provider: "sub", modelId: "model<unsafe>", source: "subagent", usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 1, totalTokens: 4, costUsd: 0.01, turns: 1, assistantMessages: 1 } }],
				runs: [{ key: "run", sourceEntryId: "tr1", sourceTurnIndex: 1, runId: "run-1", agent: "developer<img>", mode: "single", model: "sub/model<unsafe>", session: { kind: "session", label: "run-1/session<script>.jsonl", basename: "session<script>.jsonl", extension: ".jsonl", runId: "run-1", pathRedacted: true }, artifacts: [{ kind: "artifact", label: "run-1/output<script>.md", basename: "output<script>.md", extension: ".md", runId: "run-1", pathRedacted: true }], usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 1, totalTokens: 4, costUsd: 0.01, turns: 1, assistantMessages: 1 }, success: true }],
			},
			references: {
				artifacts: [{ kind: "artifact", label: "run-1/output<script>.md", basename: "output<script>.md", extension: ".md", runId: "run-1", pathRedacted: true }],
				sessions: [{ kind: "session", label: "run-1/session<script>.jsonl", basename: "session<script>.jsonl", extension: ".jsonl", runId: "run-1", pathRedacted: true }],
				intercomTargets: ["subagent-chat-<unsafe>"],
			},
			caveats: ["Estimated <b>only</b>"],
		},
		{ generatedAt: "2026-06-15T00:00:02Z" },
	);

	assert.match(html, /<h2>Overview<\/h2>/);
	assert.match(html, /<h2>Timeline<\/h2>/);
	assert.match(html, /<h2>Agents\/subagents<\/h2>/);
	assert.match(html, /<h2>Tools\/MCP<\/h2>/);
	assert.match(html, /<h2>Cache<\/h2>/);
	assert.match(html, /<h2>Caveats<\/h2>/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(html, /tool&lt;script&gt;/);
	assert.match(html, /Extension &lt;unsafe&gt;/);
	assert.match(html, /Estimated &lt;b&gt;only&lt;\/b&gt;/);
	assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
	assert.doesNotMatch(html, /developer<img>/);
	assert.doesNotMatch(html, /run-1\/output<script>\.md/);
});

test("analyzeSessionEntries computes non-zero approxTokens for tool calls and results", () => {
	const entries = [
		userEntry("u1", null, "2026-06-17T10:00:00Z", "user message"),
		assistantEntry("a1", "u1", "2026-06-17T10:00:05Z", {
			stopReason: "tool_use",
			content: [
				{ type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "echo hello world" } },
				{ type: "toolCall", id: "call-mcp-1", name: "mcp", arguments: { server: "search", query: "example query text" } },
			],
			usage: usage({ input: 100, output: 10, cost: 0.2 }),
		}),
		toolResultEntry("tr1", "a1", "2026-06-17T10:00:06Z", "bash", {}, false, "hello world"),
		toolResultEntry("tr2", "a1", "2026-06-17T10:00:07Z", "mcp", {}, false, "search result content here"),
		assistantEntry("a2", "tr2", "2026-06-17T10:00:10Z", {
			text: "Done.",
			usage: usage({ input: 50, output: 5, cost: 0.1 }),
		}),
	];
	const toolCatalog = [
		{ name: "bash", sourceInfo: { source: "built-in", path: "core/bash.ts", scope: "user", origin: "top-level" } },
		{ name: "mcp", sourceInfo: { source: "npm:pi-mcp-adapter", path: "extensions/mcp.mjs", scope: "user", origin: "package" } },
	];
	const analysis = analyzeSessionEntries(entries, { toolCatalog });

	// Per-tool approxTokens should be non-zero when there are calls and results
	const bashTool = analysis.tools.byTool.find((t) => t.toolName === "bash");
	assert.ok(bashTool, "bash tool present in byTool");
	assert.ok(bashTool.approxTokens > 0, "bash tool has non-zero approxTokens");

	const mcpTool = analysis.tools.byTool.find((t) => t.toolName === "mcp");
	assert.ok(mcpTool, "mcp tool present in byTool");
	assert.ok(mcpTool.approxTokens > 0, "mcp tool has non-zero approxTokens");

	// Per-source approxTokens should be non-zero
	const mcpSource = analysis.tools.bySource.find((s) => s.source.kind === "mcp-proxy");
	assert.ok(mcpSource, "mcp-proxy source present in bySource");
	assert.ok(mcpSource.approxTokens > 0, "mcp-proxy source has non-zero approxTokens");

	// Aggregate totals should be non-zero
	assert.ok(analysis.tools.mcpApproxTokens > 0, "mcpApproxTokens is non-zero");
	assert.ok(analysis.tools.totalToolApproxTokens > 0, "totalToolApproxTokens is non-zero");

	// MCP total should equal the mcp tool's approxTokens only
	assert.equal(analysis.tools.mcpApproxTokens, mcpTool.approxTokens, "mcpApproxTokens matches mcp tool approxTokens");

	// Total should be sum of all tools
	const expectedTotal = analysis.tools.byTool.reduce((sum, t) => sum + t.approxTokens, 0);
	assert.equal(analysis.tools.totalToolApproxTokens, expectedTotal, "totalToolApproxTokens is sum of all per-tool approxTokens");
});

test("buildTokensReportHtml renders MCP est. tokens card and Est. tokens columns in Tools/MCP section", () => {
	const entries = [
		userEntry("u1", null, "2026-06-17T10:00:00Z", "user message"),
		assistantEntry("a1", "u1", "2026-06-17T10:00:05Z", {
			stopReason: "tool_use",
			content: [
				{ type: "toolCall", id: "call-mcp-1", name: "mcp", arguments: { server: "search", query: "example" } },
			],
			usage: usage({ input: 80, output: 10, cost: 0.18 }),
		}),
		toolResultEntry("tr1", "a1", "2026-06-17T10:00:06Z", "mcp", {}, false, "result content"),
		assistantEntry("a2", "tr1", "2026-06-17T10:00:10Z", {
			text: "Done.",
			usage: usage({ input: 40, output: 5, cost: 0.08 }),
		}),
	];
	const toolCatalog = [
		{ name: "mcp", sourceInfo: { source: "npm:pi-mcp-adapter", path: "extensions/mcp.mjs", scope: "user", origin: "package" } },
	];
	const analysis = analyzeSessionEntries(entries, { toolCatalog });
	const html = buildTokensReportHtml(analysis, { generatedAt: "2026-06-17T10:01:00Z" });

	// MCP est. tokens metric card should appear
	assert.match(html, /MCP est\. tokens/);
	// Detail line with all-tools estimate
	assert.match(html, /all-tools est\./);

	// Est. tokens column header should appear in both tables (Tools and Tool sources)
	const estTokensMatches = [...html.matchAll(/Est\. tokens/g)];
	assert.ok(estTokensMatches.length >= 2, `Expected at least 2 "Est. tokens" column headers, found ${estTokensMatches.length}`);

	// The tool estimates caveat should appear
	assert.match(html, /~4 chars\/token/);
	assert.match(html, /not provider-reported/);
});

test("analyzeSessionEntries counts result-content characters toward a tool's approxTokens even when tool arguments are empty", () => {
	// Verify result-content text alone drives approxTokens (i.e. the assertion
	// approxTokens > 0 cannot pass only because of argument bytes).
	const RESULT_TEXT = "Result text that is longer than a few characters."; // 49 chars → ≥1 token
	const entries = [
		userEntry("u1", null, "2026-06-17T11:00:00Z", "user message"),
		assistantEntry("a1", "u1", "2026-06-17T11:00:05Z", {
			stopReason: "tool_use",
			content: [
				// null arguments → safeArgChars returns 0, so arg tokens = 0
				{ type: "toolCall", id: "call-read-1", name: "read-file", arguments: null },
			],
			usage: usage({ input: 50, output: 5, cost: 0.1 }),
		}),
		toolResultEntry("tr1", "a1", "2026-06-17T11:00:06Z", "read-file", {}, false, RESULT_TEXT),
		assistantEntry("a2", "tr1", "2026-06-17T11:00:10Z", {
			text: "Done.",
			usage: usage({ input: 30, output: 3, cost: 0.05 }),
		}),
	];
	const toolCatalog = [
		{ name: "read-file", sourceInfo: { source: "built-in", path: "core/read.ts", scope: "user", origin: "top-level" } },
	];
	const analysis = analyzeSessionEntries(entries, { toolCatalog });

	const readTool = analysis.tools.byTool.find((t) => t.toolName === "read-file");
	assert.ok(readTool, "read-file tool present in byTool");
	// callCount is 1 but arguments were null, so arg tokens = 0; only result chars drive approxTokens
	assert.equal(readTool.callCount, 1, "callCount is 1");
	assert.equal(readTool.resultCount, 1, "resultCount is 1");
	// RESULT_TEXT is 49 chars → Math.ceil(49/4) = 13 tokens; arg contribution = 0
	const expectedApproxTokens = Math.ceil(RESULT_TEXT.length / 4);
	assert.equal(readTool.approxTokens, expectedApproxTokens, `approxTokens (${readTool.approxTokens}) equals result-content estimate (${expectedApproxTokens})`);
	assert.ok(readTool.approxTokens > 0, "result-content text alone contributes non-zero approxTokens");
});

test("analyzeSessionEntries byTool sorts by approxTokens descending, with callCount as tiebreaker", () => {
	// expensive-tool: 1 call, 400-char result → 100 approxTokens
	// cheap-tool: 3 calls, 4-char result each → 3 approxTokens total
	// Expected byTool order: expensive-tool first (higher approxTokens), cheap-tool second
	const EXPENSIVE_RESULT = "E".repeat(400); // 400 chars → Math.ceil(400/4) = 100 tokens
	const CHEAP_RESULT = "c".repeat(4); // 4 chars → Math.ceil(4/4) = 1 token each
	const entries = [
		userEntry("u1", null, "2026-06-17T12:00:00Z", "user message"),
		assistantEntry("a1", "u1", "2026-06-17T12:00:05Z", {
			stopReason: "tool_use",
			content: [
				{ type: "toolCall", id: "call-exp-1", name: "expensive-tool", arguments: null },
				{ type: "toolCall", id: "call-cheap-1", name: "cheap-tool", arguments: null },
				{ type: "toolCall", id: "call-cheap-2", name: "cheap-tool", arguments: null },
				{ type: "toolCall", id: "call-cheap-3", name: "cheap-tool", arguments: null },
			],
			usage: usage({ input: 100, output: 10, cost: 0.2 }),
		}),
		toolResultEntry("tr1", "a1", "2026-06-17T12:00:06Z", "expensive-tool", {}, false, EXPENSIVE_RESULT),
		toolResultEntry("tr2", "a1", "2026-06-17T12:00:07Z", "cheap-tool", {}, false, CHEAP_RESULT),
		toolResultEntry("tr3", "a1", "2026-06-17T12:00:08Z", "cheap-tool", {}, false, CHEAP_RESULT),
		toolResultEntry("tr4", "a1", "2026-06-17T12:00:09Z", "cheap-tool", {}, false, CHEAP_RESULT),
		assistantEntry("a2", "tr4", "2026-06-17T12:00:15Z", {
			text: "Done.",
			usage: usage({ input: 50, output: 5, cost: 0.1 }),
		}),
	];
	const toolCatalog = [
		{ name: "expensive-tool", sourceInfo: { source: "built-in", path: "core/expensive.ts", scope: "user", origin: "top-level" } },
		{ name: "cheap-tool", sourceInfo: { source: "built-in", path: "core/cheap.ts", scope: "user", origin: "top-level" } },
	];
	const analysis = analyzeSessionEntries(entries, { toolCatalog });

	const expensiveTool = analysis.tools.byTool.find((t) => t.toolName === "expensive-tool");
	const cheapTool = analysis.tools.byTool.find((t) => t.toolName === "cheap-tool");
	assert.ok(expensiveTool, "expensive-tool present in byTool");
	assert.ok(cheapTool, "cheap-tool present in byTool");

	// Verify the token counts are as expected
	const expectedExpensive = Math.ceil(EXPENSIVE_RESULT.length / 4); // 100
	const expectedCheap = 3 * Math.ceil(CHEAP_RESULT.length / 4); // 3
	assert.equal(expensiveTool.approxTokens, expectedExpensive, `expensive-tool approxTokens is ${expectedExpensive}`);
	assert.equal(cheapTool.approxTokens, expectedCheap, `cheap-tool approxTokens is ${expectedCheap}`);
	assert.equal(cheapTool.callCount, 3, "cheap-tool has 3 calls");
	assert.equal(expensiveTool.callCount, 1, "expensive-tool has 1 call");

	// byTool should rank by approxTokens desc: expensive-tool first despite fewer calls
	assert.ok(expensiveTool.approxTokens > cheapTool.approxTokens, "expensive-tool has more approxTokens");
	assert.ok(cheapTool.callCount > expensiveTool.callCount, "cheap-tool has more calls");
	assert.equal(analysis.tools.byTool[0].toolName, "expensive-tool", "byTool[0] is expensive-tool (highest approxTokens)");
	assert.equal(analysis.tools.byTool[1].toolName, "cheap-tool", "byTool[1] is cheap-tool (lower approxTokens despite more calls)");
});

// ---------------------------------------------------------------------------
// renderUsageTotalsTable – Provider column and per-subagent sub-rows
// ---------------------------------------------------------------------------

function makeMinimalAnalysis(overrides = {}) {
	const zeroTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0, assistantMessages: 0 };
	return {
		cacheMisses: { missedTokens: 0, missedCost: 0, missCount: 0, worst: [] },
		session: {
			sessionId: "s1",
			sessionName: "Test",
			startedAt: "2026-07-12T00:00:00Z",
			entryCount: 1,
			leafCount: 1,
			activeLeafId: "a1",
			assistantTurnsOnActiveBranch: 1,
			assistantTurnsOffActiveBranch: 0,
		},
		totals: {
			primary: { ...zeroTotals, inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.02, turns: 1, assistantMessages: 1 },
			subagents: { ...zeroTotals, inputTokens: 20, outputTokens: 8, totalTokens: 28, costUsd: 0.05, turns: 2, assistantMessages: 2 },
			combined: { ...zeroTotals, inputTokens: 30, outputTokens: 13, totalTokens: 43, costUsd: 0.07, turns: 3, assistantMessages: 3 },
		},
		primaryAssistant: {
			usage: { ...zeroTotals },
			usageCoverage: { assistantMessages: 1, withUsage: 1, withoutUsage: 0 },
			models: [],
			timeline: [],
		},
		tools: {
			precision: "estimated",
			totalCalls: 0,
			totalResults: 0,
			totalErrors: 0,
			mcpCalls: 0,
			mcpProxyCalls: 0,
			mcpDirectCalls: 0,
			mcpApproxTokens: 0,
			totalToolApproxTokens: 0,
			byTool: [],
			bySource: [],
		},
		subagents: {
			precision: "discoverable-only",
			runCount: 0,
			usage: { ...zeroTotals },
			models: [],
			byAgent: [],
			runs: [],
		},
		references: { artifacts: [], sessions: [], intercomTargets: [] },
		caveats: [],
		...overrides,
	};
}

test("renderUsageTotalsTable includes Provider column header and preserves Primary assistant and Combined rows", () => {
	const analysis = makeMinimalAnalysis();
	const html = buildTokensReportHtml(analysis, { generatedAt: "2026-07-12T00:00:00Z" });

	// Provider column header must be present
	assert.match(html, /<th>Provider<\/th>/);

	// Primary assistant row uses em-dash for provider
	assert.match(html, /<td>Primary assistant<\/td><td>\u2014<\/td>/);

	// Subagents (all) subtotal row uses em-dash for provider
	assert.match(html, /<td>Subagents \(all\)<\/td><td>\u2014<\/td>/);

	// Combined row uses em-dash for provider
	assert.match(html, /<td>Combined<\/td><td>\u2014<\/td>/);
});

test("renderUsageTotalsTable renders per-subagent sub-rows with plain agent name (no arrow prefix) and provider", () => {
	const zeroTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0, assistantMessages: 0 };
	const analysis = makeMinimalAnalysis({
		subagents: {
			precision: "discoverable-only",
			runCount: 2,
			usage: { ...zeroTotals },
			models: [],
			byAgent: [
				{ key: "developer|anthropic", agent: "developer", provider: "anthropic", usage: { ...zeroTotals, inputTokens: 12, outputTokens: 4, totalTokens: 16, costUsd: 0.03, turns: 1, assistantMessages: 1 } },
				{ key: "reviewer|openai", agent: "reviewer", provider: "openai", usage: { ...zeroTotals, inputTokens: 8, outputTokens: 4, totalTokens: 12, costUsd: 0.02, turns: 1, assistantMessages: 1 } },
			],
			runs: [],
		},
	});
	const html = buildTokensReportHtml(analysis, { generatedAt: "2026-07-12T00:00:00Z" });

	// Sub-row for developer/anthropic: plain name, no ↳ prefix
	assert.match(html, /<td>developer<\/td><td>anthropic<\/td>/);

	// Sub-row for reviewer/openai: plain name, no ↳ prefix
	assert.match(html, /<td>reviewer<\/td><td>openai<\/td>/);

	// No arrow prefix (\u21b3) anywhere in the sub-row section
	assert.doesNotMatch(html, /\u21b3/);

	// Subagents (all) subtotal row still present
	assert.match(html, /<td>Subagents \(all\)<\/td><td>\u2014<\/td>/);

	// Sub-rows appear before the Subagents (all) row in document order
	const developerIdx = html.indexOf("<td>developer</td>");
	const subtotalIdx = html.indexOf("Subagents (all)");
	assert.ok(developerIdx < subtotalIdx, "developer sub-row appears before Subagents (all) subtotal");
});

test("renderUsageTotalsTable renders 'unknown' for missing agent name in sub-row (no arrow prefix)", () => {
	const zeroTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0, assistantMessages: 0 };
	const analysis = makeMinimalAnalysis({
		subagents: {
			precision: "discoverable-only",
			runCount: 1,
			usage: { ...zeroTotals },
			models: [],
			byAgent: [
				{ key: "|anthropic", agent: undefined, provider: "anthropic", usage: { ...zeroTotals, turns: 1, assistantMessages: 1 } },
			],
			runs: [],
		},
	});
	const html = buildTokensReportHtml(analysis, { generatedAt: "2026-07-12T00:00:00Z" });

	// Agent label falls back to literal 'unknown' (not em-dash, not arrow) when agent is undefined
	assert.match(html, /<td>unknown<\/td><td>anthropic<\/td>/);

	// No ↳ arrow prefix
	assert.doesNotMatch(html, /\u21b3/);

	// No em-dash used for missing agent (em-dash is only for provider-less rows)
	assert.doesNotMatch(html, /<td>\u2014<\/td><td>anthropic<\/td>/);
});

test("buildTokensReportHtml section order is: Overview, Tools/MCP, Cache misses, Timeline, Agents/subagents, Cache, Caveats", () => {
	const analysis = makeMinimalAnalysis();
	const html = buildTokensReportHtml(analysis, { generatedAt: "2026-07-12T00:00:00Z" });

	const overviewIdx = html.indexOf("<h2>Overview</h2>");
	const toolsMcpIdx = html.indexOf("<h2>Tools/MCP</h2>");
	const cacheMissesIdx = html.indexOf("<h2>Cache misses</h2>");
	const timelineIdx = html.indexOf("<h2>Timeline</h2>");
	const agentsIdx = html.indexOf("<h2>Agents/subagents</h2>");
	const cacheIdx = html.indexOf("<h2>Cache</h2>");
	const caveatsIdx = html.indexOf("<h2>Caveats</h2>");

	assert.ok(overviewIdx !== -1, "Overview section present");
	assert.ok(toolsMcpIdx !== -1, "Tools/MCP section present");
	assert.ok(cacheMissesIdx !== -1, "Cache misses section present");
	assert.ok(timelineIdx !== -1, "Timeline section present");
	assert.ok(agentsIdx !== -1, "Agents/subagents section present");
	assert.ok(cacheIdx !== -1, "Cache section present");
	assert.ok(caveatsIdx !== -1, "Caveats section present");

	assert.ok(overviewIdx < toolsMcpIdx, "Overview before Tools/MCP");
	assert.ok(toolsMcpIdx < cacheMissesIdx, "Tools/MCP before Cache misses");
	assert.ok(cacheMissesIdx < timelineIdx, "Cache misses before Timeline");
	assert.ok(timelineIdx < agentsIdx, "Timeline before Agents/subagents");
	assert.ok(agentsIdx < cacheIdx, "Agents/subagents before Cache");
	assert.ok(cacheIdx < caveatsIdx, "Cache before Caveats");
});

// ---------------------------------------------------------------------------
// Primary-agent label threading
// ---------------------------------------------------------------------------

test("buildTokensReportHtml uses a provided primaryAgentLabel in all four primary-bucket sites", () => {
	const analysis = makeMinimalAnalysis({
		primaryAssistant: {
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0, assistantMessages: 0 },
			usageCoverage: { assistantMessages: 1, withUsage: 1, withoutUsage: 0 },
			models: [
				{ key: "openai/gpt-5", provider: "openai", modelId: "gpt-5", source: "primary", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, costUsd: 0.02, turns: 1, assistantMessages: 1 } },
			],
			timeline: [],
		},
	});
	const html = buildTokensReportHtml(analysis, { generatedAt: "2026-07-12T00:00:00Z", primaryAgentLabel: "architect" });

	// Site 1: renderUsageTotalsTable primary row Bucket cell
	assert.match(html, /<td>architect<\/td><td>\u2014<\/td>/, "site 1: usage totals table primary row uses provided label");

	// Site 2: Overview metric card title
	assert.match(html, /<p class="card-label">architect<\/p>/, "site 2: Overview metric card title uses provided label");

	// Site 3: models table heading becomes '<label> models'
	assert.match(html, /<h3>architect models<\/h3>/, "site 3: models table heading uses provided label");

	// Site 4: renderCacheTotalsTable primary row
	// The cache table has 'architect' as the first bucket row (before Subagents and Combined)
	const cacheTableIdx = html.indexOf("<h2>Cache</h2>");
	const cacheSection = html.slice(cacheTableIdx);
	const architectInCache = cacheSection.indexOf("<td>architect</td>");
	assert.ok(architectInCache !== -1, "site 4: cache totals table primary row uses provided label");

	// Fallback label 'Primary assistant' must NOT appear as primary bucket (subagent and combined rows unaffected)
	assert.doesNotMatch(html, /<td>Primary assistant<\/td><td>\u2014<\/td>/, "fallback label absent when custom label provided");
});

test("buildTokensReportHtml falls back to 'Primary assistant' when no primaryAgentLabel is given", () => {
	const analysis = makeMinimalAnalysis({
		primaryAssistant: {
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0, assistantMessages: 0 },
			usageCoverage: { assistantMessages: 1, withUsage: 1, withoutUsage: 0 },
			models: [],
			timeline: [],
		},
	});
	const html = buildTokensReportHtml(analysis, { generatedAt: "2026-07-12T00:00:00Z" });

	// Site 1: usage totals table primary row
	assert.match(html, /<td>Primary assistant<\/td><td>\u2014<\/td>/, "site 1: fallback label in usage totals table");

	// Site 2: Overview metric card title
	assert.match(html, /<p class="card-label">Primary assistant<\/p>/, "site 2: fallback label in Overview metric card");

	// Site 3: models table heading
	assert.match(html, /<h3>Primary assistant models<\/h3>/, "site 3: fallback label in models table heading");

	// Site 4: cache totals table primary row
	const cacheTableIdx = html.indexOf("<h2>Cache</h2>");
	const cacheSection = html.slice(cacheTableIdx);
	assert.ok(cacheSection.indexOf("<td>Primary assistant</td>") !== -1, "site 4: fallback label in cache totals table");
});

test("createTokensCommandHandler passes getPrimaryAgentLabel to the report (integration)", async (t) => {
	const sessionDir = makeTempDir("tlh-tokens-label-", t);
	const pi = createPiHarness();
	let openedPath;
	registerTokensCommand(pi, {
		openReport: async (path) => { openedPath = path; },
		now: () => new Date("2026-07-12T00:00:00Z"),
		getPrimaryAgentLabel: () => "architect",
	});
	const command = pi.commands.get("tokens");
	const { ctx } = createCommandContext({ sessionDir, entries: [] });
	await command.handler("", ctx);
	assert.ok(openedPath, "report was opened");
	const html = readFileSync(openedPath, "utf8");
	assert.match(html, /<p class="card-label">architect<\/p>/, "metric card uses provided label");
	assert.match(html, /<h3>architect models<\/h3>/, "models heading uses provided label");
});

test("renderUsageTotalsTable renders no sub-rows but still shows Subagents (all) when byAgent is empty", () => {
	const analysis = makeMinimalAnalysis();
	// byAgent is [] by default in makeMinimalAnalysis
	const html = buildTokensReportHtml(analysis, { generatedAt: "2026-07-12T00:00:00Z" });

	// No ↳ rows
	assert.doesNotMatch(html, /\u21b3/);

	// Subagents (all) row still present
	assert.match(html, /<td>Subagents \(all\)<\/td><td>\u2014<\/td>/);
});

// ---------------------------------------------------------------------------
// Cache misses section
// ---------------------------------------------------------------------------

test("buildTokensReportHtml renders Cache misses section with cards and worst table when missCount > 0", () => {
	const analysis = makeMinimalAnalysis({
		cacheMisses: {
			missedTokens: 12_500,
			missedCost: 0.0375,
			missCount: 3,
			worst: [
				{ turnIndex: 4, idleMs: 420_000, modelChanged: false, missedTokens: 8000, missedCost: 0.024 },
				{ turnIndex: 9, idleMs: 25_000, modelChanged: true, missedTokens: 3000, missedCost: 0.009 },
				{ turnIndex: 1, idleMs: 45_000, modelChanged: false, missedTokens: 1500, missedCost: 0.0045 },
			],
		},
	});
	const html = buildTokensReportHtml(analysis, { generatedAt: "2026-07-12T00:00:00Z" });

	// Section heading present
	assert.match(html, /<h2>Cache misses<\/h2>/);

	// Explanatory note present
	assert.match(html, /A cache miss is prompt content/);
	assert.match(html, /Only misses above a small noise floor are counted\./);

	// Three metric cards
	assert.match(html, /Missed tokens/);
	assert.match(html, /Extra cost/);
	assert.match(html, /Miss count/);
	// Values: 12,500 tokens, 3 misses
	assert.match(html, /12,500/);
	assert.match(html, />3</);

	// Worst-misses table column headers
	assert.match(html, /<th>Turn<\/th>/);
	assert.match(html, /<th>Idle gap<\/th>/);
	assert.match(html, /<th>Model changed<\/th>/);
	assert.match(html, /<th>Missed tokens<\/th>/);
	assert.match(html, /<th>Extra cost<\/th>/);

	// Turn indices are 1-based (turnIndex 4 → "5", turnIndex 9 → "10", turnIndex 1 → "2")
	assert.match(html, /<td>5<\/td>/);
	assert.match(html, /<td>10<\/td>/);
	assert.match(html, /<td>2<\/td>/);

	// Idle gap formatting: 420,000ms → 7 min; 25,000ms → 25s; 45,000ms → 45s
	assert.match(html, /7 min/);
	assert.match(html, /25s/);
	assert.match(html, /45s/);

	// modelChanged rendered as yes/no
	assert.match(html, /<td>no<\/td>/);
	assert.match(html, /<td>yes<\/td>/);

	// Section is positioned after Tools/MCP and before Timeline
	const toolsMcpIdx = html.indexOf("<h2>Tools/MCP</h2>");
	const cacheMissesIdx = html.indexOf("<h2>Cache misses</h2>");
	const timelineIdx = html.indexOf("<h2>Timeline</h2>");
	assert.ok(toolsMcpIdx < cacheMissesIdx, "Cache misses after Tools/MCP");
	assert.ok(cacheMissesIdx < timelineIdx, "Cache misses before Timeline");
});

test("buildTokensReportHtml renders Cache misses empty state when missCount is 0", () => {
	// makeMinimalAnalysis already defaults cacheMisses to missCount=0
	const analysis = makeMinimalAnalysis();
	const html = buildTokensReportHtml(analysis, { generatedAt: "2026-07-12T00:00:00Z" });

	// Section heading present
	assert.match(html, /<h2>Cache misses<\/h2>/);

	// Explanatory note present
	assert.match(html, /A cache miss is prompt content/);

	// Empty-state note present
	assert.match(html, /No significant cache misses detected\./);

	// No worst-misses table columns (table is omitted in empty state)
	assert.doesNotMatch(html, /<th>Idle gap<\/th>/);
	assert.doesNotMatch(html, /<th>Model changed<\/th>/);
});
