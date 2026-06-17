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
