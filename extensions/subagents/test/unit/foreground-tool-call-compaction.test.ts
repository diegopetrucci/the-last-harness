import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactForegroundResult, extractToolArgsPreview } from "../../src/shared/utils.ts";
import { formatToolCall } from "../../src/shared/formatters.ts";

describe("foreground tool-call compaction", () => {
	it("stores compact tool-call summaries instead of raw message payloads", () => {
		const result = compactForegroundResult({
			agent: "tester",
			task: "run checks",
			exitCode: 0,
			messages: [
				{
					role: "assistant" as const,
					content: [
						{
							type: "toolCall" as const,
							id: "tool-call-1",
							name: "write",
							arguments: {
								path: "/tmp/report.md",
								content: "x".repeat(50_000),
							},
						},
					],
					api: "anthropic-messages" as const,
					provider: "anthropic",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: Date.now(),
				},
			],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		});

		assert.equal(result.messages, undefined);
		assert.deepEqual(result.toolCalls, [{ text: "write /tmp/report.md" }]);
	});

	it("preserves complete generic tool-call payloads for both views", () => {
		const payload = "x".repeat(500);
		const collapsed = formatToolCall("custom", { payload });
		const expanded = formatToolCall("custom", { payload }, true);

		assert.equal(expanded, collapsed);
		assert.match(expanded, new RegExp(payload));
	});

	it("stores a duplicate tool-call string only once while retaining distinct expanded text", () => {
		const result = compactForegroundResult({
			agent: "tester",
			task: "run checks",
			exitCode: 0,
			messages: [],
			toolCalls: [
				{ text: "same complete call", expandedText: "same complete call" },
				{ text: "compact call", expandedText: "expanded complete call" },
			],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		});

		assert.deepEqual(result.toolCalls, [
			{ text: "same complete call" },
			{ text: "compact call", expandedText: "expanded complete call" },
		]);
	});

	it("does not keep an empty toolCalls array after compaction", () => {
		const result = compactForegroundResult({
			agent: "tester",
			task: "run checks",
			exitCode: 0,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		});

		assert.equal(result.toolCalls, undefined);
	});

	it("formats array-based web search previews clearly", () => {
		assert.equal(
			extractToolArgsPreview({
				queries: ["Chrome native messaging manifest path macOS", "Chromium native messaging path macOS"],
				workflow: "none",
			}),
			"Chrome native messaging manifest path macOS (+1 more)",
		);
	});

	it("preserves complete long command arguments", () => {
		const command = `npm run validate -- --filter=${"x".repeat(100)}`;
		assert.equal(extractToolArgsPreview({ command }), command);
		assert.equal(formatToolCall("bash", { command }), `$ ${command}`);
	});

	it("preserves complete long path arguments", () => {
		const filePath = `/workspace/${"nested/".repeat(16)}report.json`;
		assert.equal(extractToolArgsPreview({ path: filePath }), filePath);
	});

	it("preserves complete URL arguments and array summaries", () => {
		const url = "https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging";
		assert.equal(extractToolArgsPreview({ url }), url);
		assert.equal(
			extractToolArgsPreview({
				urls: [url, "https://example.com/backup"],
			}),
			`${url} (+1 more)`,
		);
	});

	it("preserves complete prompt arguments", () => {
		const prompt = `Investigate this behavior and report every relevant detail: ${"context ".repeat(20)}`;
		assert.equal(extractToolArgsPreview({ prompt }), prompt);
	});

	it("preserves complete workflow arguments", () => {
		const workflow = `review-${"phase-".repeat(20)}`;
		assert.equal(extractToolArgsPreview({ workflow }), `workflow=${workflow}`);
	});

	it("preserves complete MCP tool arguments", () => {
		const mcpArgs = `{"query":"${"result-".repeat(20)}"}`;
		assert.equal(extractToolArgsPreview({ server: "docs", tool: "search", args: mcpArgs }), `docs/search ${mcpArgs}`);
	});

	it("preserves complete fallback values", () => {
		const value = "custom-" + "value-".repeat(20);
		assert.equal(extractToolArgsPreview({ custom: value }), `custom=${value}`);
		assert.equal(
			extractToolArgsPreview({ ids: [`run-${"long-".repeat(20)}`, "run-b", "run-c"] }),
			`ids=run-${"long-".repeat(20)} (+2 more)`,
		);
	});
});
