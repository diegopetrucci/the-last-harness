import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	aggregateCoverage,
	extractSubagentCorrelations,
	readSessionHeader,
	scanSessionFile,
} from "../scripts/lib/session-analysis.mjs";
import { makeTempDir } from "./test-fixture-helpers.mjs";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function sessionHeader(id = "sess-001", cwd = "/workspace") {
	return JSON.stringify({
		type: "session",
		version: 1,
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
	});
}

function assistantMessageLine(timestamp, toolCalls = []) {
	const content = toolCalls.map(({ toolCallId, toolName }) => ({
		type: "toolCall",
		toolCallId,
		toolName,
	}));
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			model: "claude-opus-5",
			provider: "anthropic",
			api: "bedrock",
			responseId: "resp-1",
			stopReason: "tool_use",
			usage: {},
			content,
			timestamp,
		},
	});
}

function toolResultLine(timestamp, toolCallId, toolName = "bash", options = {}) {
	return JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			isError: options.isError ?? false,
			content: [{ type: "text", text: options.output ?? "ok" }],
			...(options.details ? { details: options.details } : {}),
			timestamp,
		},
	});
}

function writeFixture(t, lines, { noTrailingNewline = false, filename = "session.jsonl" } = {}) {
	const dir = makeTempDir("session-analysis-test-", t);
	const filePath = join(dir, filename);
	const content = lines.join("\n") + (noTrailingNewline ? "" : "\n");
	writeFileSync(filePath, content, "utf8");
	return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("scanSessionFile: parses session header and a simple tool call pair", async (t) => {
	const filePath = writeFixture(t, [
		sessionHeader(),
		assistantMessageLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-1", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-1"),
	]);

	const result = await scanSessionFile(filePath);

	assert.equal(result.sessionHeader?.id, "sess-001");
	assert.equal(result.sessionHeader?.cwd, "/workspace");
	assert.equal(result.toolPairs.length, 1);
	assert.equal(result.toolPairs[0]?.toolCallId, "tc-1");
	assert.equal(result.toolPairs[0]?.toolName, "bash");
	assert.equal(result.toolPairs[0]?.observedLatencyMs, 1000);
	assert.equal(result.toolPairs[0]?.isError, false);
	assert.equal(result.malformedLines, 0);
	assert.equal(result.unmatchedToolCallCount, 0);
	assert.equal(result.unmatchedToolResultCount, 0);
	assert.equal(result.observedToolCallCount, 1);
	assert.equal(result.duplicateToolCallIdCount, 0);
	assert.equal(result.invalidTimestampPairCount, 0);
});

test("scanSessionFile: skips and counts malformed lines without throwing", async (t) => {
	const filePath = writeFixture(t, [
		sessionHeader(),
		"this is not json {{{",
		assistantMessageLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-2", toolName: "bash" }]),
		"   ",
		"{broken json",
		toolResultLine("2026-01-01T00:00:03.000Z", "tc-2"),
	]);

	const result = await scanSessionFile(filePath);

	// Two lines with invalid JSON should be counted
	assert.equal(result.malformedLines, 2);
	// The valid pair should still be resolved
	assert.equal(result.toolPairs.length, 1);
	assert.equal(result.toolPairs[0]?.toolCallId, "tc-2");
	assert.equal(result.toolPairs[0]?.observedLatencyMs, 2000);
});

test("scanSessionFile: tolerates unterminated final line (no trailing newline)", async (t) => {
	const filePath = writeFixture(
		t,
		[
			sessionHeader(),
			assistantMessageLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-3", toolName: "bash" }]),
			// Last line has no newline — simulates live append
			toolResultLine("2026-01-01T00:00:02.500Z", "tc-3"),
		],
		{ noTrailingNewline: true },
	);

	const result = await scanSessionFile(filePath);

	assert.equal(result.malformedLines, 0);
	assert.equal(result.toolPairs.length, 1);
	assert.equal(result.toolPairs[0]?.observedLatencyMs, 1500);
});

test("scanSessionFile: pairs multiple parallel tool calls in one assistant message by toolCallId", async (t) => {
	// One assistant message with three simultaneous tool calls, results arrive
	// in reverse order to confirm adjacency is not used for pairing.
	const filePath = writeFixture(t, [
		sessionHeader(),
		assistantMessageLine("2026-01-01T00:00:00.000Z", [
			{ toolCallId: "tc-a", toolName: "bash" },
			{ toolCallId: "tc-b", toolName: "read" },
			{ toolCallId: "tc-c", toolName: "write" },
		]),
		// Results in reverse order to prove adjacency is not used
		toolResultLine("2026-01-01T00:00:03.000Z", "tc-c", "write"),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-b", "read"),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-a", "bash"),
	]);

	const result = await scanSessionFile(filePath);

	assert.equal(result.toolPairs.length, 3);
	assert.equal(result.unmatchedToolCallCount, 0);
	assert.equal(result.unmatchedToolResultCount, 0);
	assert.equal(result.observedToolCallCount, 3);

	const byId = Object.fromEntries(result.toolPairs.map((p) => [p.toolCallId, p]));

	assert.equal(byId["tc-a"]?.toolName, "bash");
	assert.equal(byId["tc-a"]?.observedLatencyMs, 1000);

	assert.equal(byId["tc-b"]?.toolName, "read");
	assert.equal(byId["tc-b"]?.observedLatencyMs, 2000);

	assert.equal(byId["tc-c"]?.toolName, "write");
	assert.equal(byId["tc-c"]?.observedLatencyMs, 3000);
});

test("scanSessionFile: counts unmatched tool calls and tool results separately", async (t) => {
	const filePath = writeFixture(t, [
		sessionHeader(),
		// Tool call with no result
		assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-orphan-call", toolName: "bash" }]),
		// Tool result with no matching call
		toolResultLine("2026-01-01T00:00:05.000Z", "tc-orphan-result", "bash"),
	]);

	const result = await scanSessionFile(filePath);

	assert.equal(result.toolPairs.length, 0);
	assert.equal(result.unmatchedToolCallCount, 1);
	assert.equal(result.unmatchedToolResultCount, 1);
	// Fix 4: observedToolCallCount counts the call even though it is unmatched.
	assert.equal(result.observedToolCallCount, 1);
});

// ---------------------------------------------------------------------------
// Fix 1: run-history.jsonl guard
// ---------------------------------------------------------------------------

test("scanSessionFile: rejects run-history.jsonl path", async (t) => {
	const dir = makeTempDir("session-analysis-rh-", t);
	const rhPath = join(dir, "run-history.jsonl");
	writeFileSync(rhPath, '{"type":"session"}\n', "utf8");

	await assert.rejects(
		() => scanSessionFile(rhPath),
		(err) => {
			assert.ok(err instanceof Error, "must throw an Error");
			assert.ok(
				err.message.includes("run-history.jsonl"),
				`error message must mention run-history.jsonl; got: ${err.message}`,
			);
			return true;
		},
	);
});

test("scanSessionFile: rejects run-history.jsonl via symlink", async (t) => {
	const dir = makeTempDir("session-analysis-rh-sym-", t);
	const rhPath = join(dir, "run-history.jsonl");
	const linkPath = join(dir, "alias.jsonl");
	writeFileSync(rhPath, '{"type":"session"}\n', "utf8");
	symlinkSync(rhPath, linkPath);

	await assert.rejects(
		() => scanSessionFile(linkPath),
		(err) => {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes("run-history.jsonl"));
			return true;
		},
	);
});

test("readSessionHeader: rejects run-history.jsonl path", async (t) => {
	const dir = makeTempDir("session-analysis-rh-hdr-", t);
	const rhPath = join(dir, "run-history.jsonl");
	writeFileSync(rhPath, '{"type":"session"}\n', "utf8");

	await assert.rejects(
		() => readSessionHeader(rhPath),
		(err) => {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes("run-history.jsonl"));
			return true;
		},
	);
});

test("readSessionHeader: rejects run-history.jsonl via symlink", async (t) => {
	const dir = makeTempDir("session-analysis-rh-hdr-sym-", t);
	const rhPath = join(dir, "run-history.jsonl");
	const linkPath = join(dir, "alias.jsonl");
	writeFileSync(rhPath, '{"type":"session"}\n', "utf8");
	symlinkSync(rhPath, linkPath);

	await assert.rejects(
		() => readSessionHeader(linkPath),
		(err) => {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes("run-history.jsonl"));
			return true;
		},
	);
});

// ---------------------------------------------------------------------------
// Fix 2: extractSubagentCorrelations — subagent-only, child resolution
// ---------------------------------------------------------------------------

test("extractSubagentCorrelations: resolves parent -> child correlation from subagent tool result", async (t) => {
	const childSessionFile = "/home/user/.the-last-harness/agent/sessions/proj/parent-sess/run-1/run-1/session.jsonl";

	const filePath = writeFixture(t, [
		sessionHeader("parent-sess-id"),
		assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-sub", toolName: "subagent" }]),
		toolResultLine("2026-01-01T00:00:10.000Z", "tc-sub", "subagent", {
			details: {
				runId: "run-abc123",
				results: [
					{ agent: "code-agent", sessionFile: childSessionFile },
				],
			},
		}),
	]);

	const scan = await scanSessionFile(filePath);
	assert.equal(scan.toolPairs.length, 1);
	assert.equal(scan.toolPairs[0]?.observedLatencyMs, 10000);

	const correlations = await extractSubagentCorrelations(scan);
	assert.equal(correlations.length, 1);

	const c = correlations[0];
	assert.equal(c?.parentSessionId, "parent-sess-id");
	assert.equal(c?.toolCallId, "tc-sub");
	assert.equal(c?.runId, "run-abc123");
	assert.equal(c?.agent, "code-agent");
	assert.equal(c?.childSessionFile, childSessionFile);
});

test("extractSubagentCorrelations: only extracts from subagent tool calls, not other tools", async (t) => {
	const filePath = writeFixture(t, [
		sessionHeader("parent-filter"),
		// bash tool with subagent-like details — must NOT produce a correlation
		assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-bash", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-bash", "bash", {
			details: {
				runId: "run-fake",
				results: [{ agent: "impostor", sessionFile: "/sessions/fake/session.jsonl" }],
			},
		}),
		// subagent tool — MUST produce a correlation
		assistantMessageLine("2026-01-01T00:00:02.000Z", [{ toolCallId: "tc-sub", toolName: "subagent" }]),
		toolResultLine("2026-01-01T00:00:03.000Z", "tc-sub", "subagent", {
			details: {
				runId: "run-real",
				results: [{ agent: "real-agent", sessionFile: "/sessions/real/session.jsonl" }],
			},
		}),
	]);

	const scan = await scanSessionFile(filePath);
	const correlations = await extractSubagentCorrelations(scan);
	assert.equal(correlations.length, 1, "must only produce correlation from subagent tool");
	assert.equal(correlations[0]?.runId, "run-real");
});

test("extractSubagentCorrelations: emits one correlation per child sessionFile in results array", async (t) => {
	const childA = "/sessions/child-a/session.jsonl";
	const childB = "/sessions/child-b/session.jsonl";

	const filePath = writeFixture(t, [
		sessionHeader("parent-multi"),
		assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-multi", toolName: "subagent" }]),
		toolResultLine("2026-01-01T00:00:05.000Z", "tc-multi", "subagent", {
			details: {
				runId: "run-multi",
				results: [
					{ agent: "agent-a", sessionFile: childA },
					{ agent: "agent-b", sessionFile: childB },
				],
			},
		}),
	]);

	const scan = await scanSessionFile(filePath);
	const correlations = await extractSubagentCorrelations(scan);
	assert.equal(correlations.length, 2);
	assert.deepEqual(
		correlations.map((c) => c.childSessionFile).sort(),
		[childA, childB].sort(),
	);
});

test("extractSubagentCorrelations: returns empty array when no session header", async (t) => {
	// File with no session header entry
	const filePath = writeFixture(t, [
		assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-x", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-x"),
	]);

	const scan = await scanSessionFile(filePath);
	assert.equal(scan.sessionHeader, null);
	assert.deepEqual(await extractSubagentCorrelations(scan), []);
});

test("extractSubagentCorrelations: skips results missing sessionFile", async (t) => {
	const filePath = writeFixture(t, [
		sessionHeader("sess-partial"),
		assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-partial", toolName: "subagent" }]),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-partial", "subagent", {
			details: {
				runId: "run-partial",
				results: [
					{ agent: "agent-no-file" }, // no sessionFile
				],
			},
		}),
	]);

	const scan = await scanSessionFile(filePath);
	const correlations = await extractSubagentCorrelations(scan);
	assert.equal(correlations.length, 0);
});

test("extractSubagentCorrelations: marks child as resolved when child file is readable and under sessionsDir", async (t) => {
	const dir = makeTempDir("session-analysis-child-resolve-", t);

	// Write child session file
	const childPath = join(dir, "sessions", "child-proj", "session.jsonl");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(join(dir, "sessions", "child-proj"), { recursive: true });
	writeFileSync(childPath, sessionHeader("child-sess-id", "/workspace") + "\n", "utf8");

	const sessionsDir = join(dir, "sessions");

	// Write parent session file (not under sessionsDir for testing purposes)
	const parentPath = writeFixture(t, [
		sessionHeader("parent-id"),
		assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-s", toolName: "subagent" }]),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-s", "subagent", {
			details: {
				runId: "run-x",
				results: [{ agent: "agent-x", sessionFile: childPath }],
			},
		}),
	]);

	const scan = await scanSessionFile(parentPath);
	const correlations = await extractSubagentCorrelations(scan, sessionsDir);
	assert.equal(correlations.length, 1);
	const c = correlations[0];
	assert.equal(c?.childResolved, true, "child must be marked resolved");
	assert.equal(c?.childSessionId, "child-sess-id");
	assert.ok(typeof c?.childStartedAt === "string");
});

test("extractSubagentCorrelations: marks child as unresolved when file does not exist", async (t) => {
	const dir = makeTempDir("session-analysis-child-missing-", t);
	const sessionsDir = join(dir, "sessions");
	const missingChild = join(sessionsDir, "ghost", "session.jsonl");

	const filePath = writeFixture(t, [
		sessionHeader("p-id"),
		assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-g", toolName: "subagent" }]),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-g", "subagent", {
			details: {
				runId: "run-g",
				results: [{ agent: "ghost", sessionFile: missingChild }],
			},
		}),
	]);

	const scan = await scanSessionFile(filePath);
	const correlations = await extractSubagentCorrelations(scan, sessionsDir);
	assert.equal(correlations.length, 1);
	assert.equal(correlations[0]?.childResolved, false);
	assert.equal(correlations[0]?.childSessionId, undefined);
});

test("extractSubagentCorrelations: does not resolve child outside sessionsDir (path safety)", async (t) => {
	const dir = makeTempDir("session-analysis-path-safety-", t);
	const sessionsDir = join(dir, "sessions");

	// Child file outside sessionsDir
	const outsidePath = join(dir, "outside", "session.jsonl");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(join(dir, "outside"), { recursive: true });
	writeFileSync(outsidePath, sessionHeader("outside-id", "/x") + "\n", "utf8");

	const filePath = writeFixture(t, [
		sessionHeader("p-id"),
		assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-o", toolName: "subagent" }]),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-o", "subagent", {
			details: {
				runId: "run-o",
				results: [{ agent: "outside", sessionFile: outsidePath }],
			},
		}),
	]);

	const scan = await scanSessionFile(filePath);
	const correlations = await extractSubagentCorrelations(scan, sessionsDir);
	assert.equal(correlations.length, 1);
	// Correlation is emitted (visible gap) but child is NOT resolved (outside boundary).
	assert.equal(correlations[0]?.childResolved, false, "child outside sessionsDir must not be resolved");
	assert.equal(correlations[0]?.childSessionId, undefined);
});

// ---------------------------------------------------------------------------
// Fix 4: honest tool-call counting and duplicate ids
// ---------------------------------------------------------------------------

test("scanSessionFile: observedToolCallCount counts all calls including unmatched", async (t) => {
	const filePath = writeFixture(t, [
		sessionHeader(),
		// Three calls, only one result
		assistantMessageLine("2026-01-01T00:00:00.000Z", [
			{ toolCallId: "tc-a", toolName: "bash" },
			{ toolCallId: "tc-b", toolName: "bash" },
			{ toolCallId: "tc-c", toolName: "bash" },
		]),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-a"),
	]);

	const result = await scanSessionFile(filePath);
	assert.equal(result.observedToolCallCount, 3, "must count all 3 observed calls");
	assert.equal(result.toolPairs.length, 1, "only one matched pair");
	assert.equal(result.unmatchedToolCallCount, 2, "two unmatched calls");
});

test("scanSessionFile: duplicate toolCallId is counted as ambiguity", async (t) => {
	const filePath = writeFixture(t, [
		sessionHeader(),
		assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-dup", toolName: "bash" }]),
		// Same toolCallId appears again — duplicate
		assistantMessageLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-dup", toolName: "read" }]),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-dup"),
	]);

	const result = await scanSessionFile(filePath);
	assert.equal(result.observedToolCallCount, 2, "both occurrences counted");
	assert.equal(result.duplicateToolCallIdCount, 1, "duplicate must be counted");
	// Only one pair (last call wins)
	assert.equal(result.toolPairs.length, 1);
});

// ---------------------------------------------------------------------------
// Fix 6: latency math robustness
// ---------------------------------------------------------------------------

test("scanSessionFile: invalid timestamps produce invalidTimestampPairCount, not NaN latency", async (t) => {
	const filePath = writeFixture(t, [
		sessionHeader(),
		// Call with invalid timestamp
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", toolCallId: "tc-bad-ts", toolName: "bash" }],
				timestamp: "not-a-date",
			},
		}),
		// Result with valid timestamp
		JSON.stringify({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "tc-bad-ts",
				toolName: "bash",
				isError: false,
				content: [],
				timestamp: "2026-01-01T00:00:01.000Z",
			},
		}),
	]);

	const result = await scanSessionFile(filePath);
	assert.equal(result.invalidTimestampPairCount, 1, "bad timestamp pair must be counted");
	assert.equal(result.toolPairs.length, 0, "invalid pair must not appear in toolPairs");
});

test("scanSessionFile: negative latency is counted as invalid, not included in toolPairs", async (t) => {
	const filePath = writeFixture(t, [
		sessionHeader(),
		// Result timestamp BEFORE call timestamp (clock skew / bad data)
		assistantMessageLine("2026-01-01T00:00:05.000Z", [{ toolCallId: "tc-neg", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-neg"),
	]);

	const result = await scanSessionFile(filePath);
	assert.equal(result.invalidTimestampPairCount, 1, "negative latency must be counted as invalid");
	assert.equal(result.toolPairs.length, 0);
});

// ---------------------------------------------------------------------------
// readSessionHeader tests
// ---------------------------------------------------------------------------

test("readSessionHeader: returns header from first valid session entry", async (t) => {
	const filePath = writeFixture(t, [
		"not json",
		sessionHeader("hdr-only-id", "/my/cwd"),
		assistantMessageLine("2026-01-01T00:00:01.000Z", []),
	]);

	const header = await readSessionHeader(filePath);
	assert.equal(header?.id, "hdr-only-id");
	assert.equal(header?.cwd, "/my/cwd");
});

test("readSessionHeader: returns null for file with no session header", async (t) => {
	const filePath = writeFixture(t, [
		assistantMessageLine("2026-01-01T00:00:01.000Z", []),
	]);

	const header = await readSessionHeader(filePath);
	assert.equal(header, null);
});

// ---------------------------------------------------------------------------
// aggregateCoverage tests
// ---------------------------------------------------------------------------

test("aggregateCoverage: sums fields across multiple scan results", () => {
	// Construct minimal fake scan results (no need to read real files)
	const results = [
		{
			filePath: "/a.jsonl",
			sessionHeader: null,
			toolPairs: [],
			malformedLines: 3,
			unmatchedToolCallCount: 1,
			unmatchedToolResultCount: 2,
			fileSizeChangedDuringScan: true,
			observedToolCallCount: 1,
			duplicateToolCallIdCount: 0,
			invalidTimestampPairCount: 0,
		},
		{
			filePath: "/b.jsonl",
			sessionHeader: null,
			toolPairs: [],
			malformedLines: 0,
			unmatchedToolCallCount: 0,
			unmatchedToolResultCount: 0,
			fileSizeChangedDuringScan: false,
			observedToolCallCount: 0,
			duplicateToolCallIdCount: 0,
			invalidTimestampPairCount: 0,
		},
		{
			filePath: "/c.jsonl",
			sessionHeader: null,
			toolPairs: [],
			malformedLines: 5,
			unmatchedToolCallCount: 2,
			unmatchedToolResultCount: 1,
			fileSizeChangedDuringScan: true,
			observedToolCallCount: 2,
			duplicateToolCallIdCount: 1,
			invalidTimestampPairCount: 2,
		},
	];

	const coverage = aggregateCoverage(results);
	assert.equal(coverage.filesScanned, 3);
	assert.equal(coverage.totalMalformedLines, 8);
	assert.equal(coverage.totalUnmatchedToolCalls, 3);
	assert.equal(coverage.totalUnmatchedToolResults, 3);
	assert.equal(coverage.filesWithSizeChange, 2);
	assert.equal(coverage.totalDuplicateToolCallIds, 1);
	assert.equal(coverage.totalInvalidTimestampPairs, 2);
	// Without extra, filesDiscovered defaults to filesScanned
	assert.equal(coverage.filesDiscovered, 3);
	assert.equal(coverage.failedScans, 0);
	assert.equal(coverage.unreadableDirectories, 0);
});

test("aggregateCoverage: extra data overrides defaults", () => {
	const coverage = aggregateCoverage([], {
		filesDiscovered: 10,
		failedScans: 3,
		unreadableDirectories: 1,
	});
	assert.equal(coverage.filesDiscovered, 10);
	assert.equal(coverage.filesScanned, 0);
	assert.equal(coverage.failedScans, 3);
	assert.equal(coverage.unreadableDirectories, 1);
});

test("scanSessionFile: accepts fixture-style timestamps at entry level (not message level)", async (t) => {
	// Some fixtures put timestamp on the outer entry, not on .message — both must work.
	const filePath = writeFixture(t, [
		sessionHeader(),
		JSON.stringify({
			type: "message",
			timestamp: "2026-01-01T00:00:01.000Z", // entry-level timestamp
			message: {
				role: "assistant",
				model: "m",
				provider: "p",
				api: "a",
				responseId: "r",
				stopReason: "tool_use",
				usage: {},
				content: [{ type: "toolCall", toolCallId: "tc-entry-ts", toolName: "bash" }],
				// no timestamp on message itself
			},
		}),
		JSON.stringify({
			type: "message",
			timestamp: "2026-01-01T00:00:02.000Z", // entry-level timestamp
			message: {
				role: "toolResult",
				toolCallId: "tc-entry-ts",
				toolName: "bash",
				isError: false,
				content: [],
				// no timestamp on message itself
			},
		}),
	]);

	const result = await scanSessionFile(filePath);
	assert.equal(result.toolPairs.length, 1);
	assert.equal(result.toolPairs[0]?.observedLatencyMs, 1000);
	assert.equal(result.malformedLines, 0);
});
