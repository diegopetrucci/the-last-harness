/**
 * Direct unit tests for the pure pairToolCalls function.
 *
 * These tests exercise the extracted logic in isolation — no file I/O,
 * no JSONL streaming, no session headers.  The function takes an array of
 * already-parsed session entries.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { computeMedian, pairToolCalls } from "../extensions/the-last-harness/tool-pairing.js";

// ---------------------------------------------------------------------------
// Entry-builder helpers
// ---------------------------------------------------------------------------

function assistantEntry(timestamp, toolCalls = []) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: toolCalls.map(({ toolCallId, toolName }) => ({
				type: "toolCall",
				toolCallId,
				toolName,
			})),
			timestamp,
		},
	};
}

function toolResultEntry(timestamp, toolCallId, { isError = false, details } = {}) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			isError,
			...(details !== undefined ? { details } : {}),
			timestamp,
		},
	};
}

// ---------------------------------------------------------------------------
// Basic pairing
// ---------------------------------------------------------------------------

test("pairToolCalls: pairs a single call and result", () => {
	const entries = [
		assistantEntry("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-1", toolName: "bash" }]),
		toolResultEntry("2026-01-01T00:00:02.000Z", "tc-1"),
	];

	const result = pairToolCalls(entries);

	assert.equal(result.toolPairs.length, 1);
	assert.equal(result.toolPairs[0]?.toolCallId, "tc-1");
	assert.equal(result.toolPairs[0]?.toolName, "bash");
	assert.equal(result.toolPairs[0]?.observedLatencyMs, 1000);
	assert.equal(result.toolPairs[0]?.isError, false);
	assert.equal(result.unmatchedToolCallCount, 0);
	assert.equal(result.unmatchedToolResultCount, 0);
	assert.equal(result.observedToolCallCount, 1);
	assert.equal(result.duplicateToolCallIdCount, 0);
	assert.equal(result.invalidTimestampPairCount, 0);
});

test("pairToolCalls: returns empty result for empty input", () => {
	const result = pairToolCalls([]);

	assert.equal(result.toolPairs.length, 0);
	assert.equal(result.unmatchedToolCallCount, 0);
	assert.equal(result.unmatchedToolResultCount, 0);
	assert.equal(result.observedToolCallCount, 0);
	assert.equal(result.duplicateToolCallIdCount, 0);
	assert.equal(result.invalidTimestampPairCount, 0);
});

// ---------------------------------------------------------------------------
// Interleaved parallel calls
// ---------------------------------------------------------------------------

test("pairToolCalls: pairs interleaved parallel calls by toolCallId, not adjacency", () => {
	const entries = [
		// Single assistant message with three simultaneous tool calls
		assistantEntry("2026-01-01T00:00:00.000Z", [
			{ toolCallId: "tc-a", toolName: "bash" },
			{ toolCallId: "tc-b", toolName: "read" },
			{ toolCallId: "tc-c", toolName: "write" },
		]),
		// Results arrive in reverse order — pairing must NOT use adjacency
		toolResultEntry("2026-01-01T00:00:03.000Z", "tc-c"),
		toolResultEntry("2026-01-01T00:00:02.000Z", "tc-b"),
		toolResultEntry("2026-01-01T00:00:01.000Z", "tc-a"),
	];

	const result = pairToolCalls(entries);

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

// ---------------------------------------------------------------------------
// Duplicate toolCallId
// ---------------------------------------------------------------------------

test("pairToolCalls: surfaces duplicate toolCallId as a statistic, last call wins", () => {
	const entries = [
		// First occurrence with toolName "bash"
		assistantEntry("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-dup", toolName: "bash" }]),
		// Second occurrence (duplicate) with toolName "read" — last wins
		assistantEntry("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-dup", toolName: "read" }]),
		toolResultEntry("2026-01-01T00:00:02.000Z", "tc-dup"),
	];

	const result = pairToolCalls(entries);

	assert.equal(result.observedToolCallCount, 2, "both occurrences must be counted");
	assert.equal(result.duplicateToolCallIdCount, 1, "duplicate must be reported");
	assert.equal(result.toolPairs.length, 1, "only one pair (last call wins)");
	// Last call had toolName "read"
	assert.equal(result.toolPairs[0]?.toolName, "read");
});

// ---------------------------------------------------------------------------
// Invalid timestamps
// ---------------------------------------------------------------------------

test("pairToolCalls: invalid call timestamp produces invalidTimestampPairCount, not NaN latency", () => {
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", toolCallId: "tc-bad-call", toolName: "bash" }],
				timestamp: "not-a-date",
			},
		},
		toolResultEntry("2026-01-01T00:00:01.000Z", "tc-bad-call"),
	];

	const result = pairToolCalls(entries);

	assert.equal(result.invalidTimestampPairCount, 1);
	assert.equal(result.toolPairs.length, 0, "invalid pair must not appear in toolPairs");
});

test("pairToolCalls: invalid result timestamp produces invalidTimestampPairCount", () => {
	const entries = [
		assistantEntry("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-bad-res", toolName: "bash" }]),
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "tc-bad-res",
				isError: false,
				timestamp: "also-not-a-date",
			},
		},
	];

	const result = pairToolCalls(entries);

	assert.equal(result.invalidTimestampPairCount, 1);
	assert.equal(result.toolPairs.length, 0);
});

test("pairToolCalls: negative latency is counted as invalid", () => {
	const entries = [
		// Result timestamp is BEFORE call timestamp
		assistantEntry("2026-01-01T00:00:05.000Z", [{ toolCallId: "tc-neg", toolName: "bash" }]),
		toolResultEntry("2026-01-01T00:00:01.000Z", "tc-neg"),
	];

	const result = pairToolCalls(entries);

	assert.equal(result.invalidTimestampPairCount, 1, "negative latency must be counted as invalid");
	assert.equal(result.toolPairs.length, 0);
});

// ---------------------------------------------------------------------------
// Unmatched call
// ---------------------------------------------------------------------------

test("pairToolCalls: unmatched tool call is counted separately", () => {
	const entries = [
		assistantEntry("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-orphan", toolName: "bash" }]),
		// No matching result
	];

	const result = pairToolCalls(entries);

	assert.equal(result.toolPairs.length, 0);
	assert.equal(result.unmatchedToolCallCount, 1);
	assert.equal(result.unmatchedToolResultCount, 0);
	assert.equal(result.observedToolCallCount, 1);
});

// ---------------------------------------------------------------------------
// Unmatched result
// ---------------------------------------------------------------------------

test("pairToolCalls: unmatched tool result is counted separately", () => {
	const entries = [
		// No matching call
		toolResultEntry("2026-01-01T00:00:01.000Z", "tc-orphan-result"),
	];

	const result = pairToolCalls(entries);

	assert.equal(result.toolPairs.length, 0);
	assert.equal(result.unmatchedToolCallCount, 0);
	assert.equal(result.unmatchedToolResultCount, 1);
	assert.equal(result.observedToolCallCount, 0);
});

test("pairToolCalls: counts unmatched calls and results independently", () => {
	const entries = [
		assistantEntry("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-call-only", toolName: "bash" }]),
		toolResultEntry("2026-01-01T00:00:01.000Z", "tc-result-only"),
	];

	const result = pairToolCalls(entries);

	assert.equal(result.toolPairs.length, 0);
	assert.equal(result.unmatchedToolCallCount, 1);
	assert.equal(result.unmatchedToolResultCount, 1);
});

// ---------------------------------------------------------------------------
// Non-message entries and noise tolerance
// ---------------------------------------------------------------------------

test("pairToolCalls: ignores non-message entries (session headers, etc.)", () => {
	const entries = [
		{ type: "session", version: 1, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x" },
		assistantEntry("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-1", toolName: "bash" }]),
		toolResultEntry("2026-01-01T00:00:02.000Z", "tc-1"),
		null,
		42,
		"a string",
	];

	const result = pairToolCalls(entries);

	assert.equal(result.toolPairs.length, 1);
	assert.equal(result.toolPairs[0]?.toolCallId, "tc-1");
	assert.equal(result.observedToolCallCount, 1);
});

// ---------------------------------------------------------------------------
// SubagentDetails passthrough
// ---------------------------------------------------------------------------

test("pairToolCalls: includes subagent details on paired result", () => {
	const entries = [
		assistantEntry("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-sub", toolName: "subagent" }]),
		toolResultEntry("2026-01-01T00:00:10.000Z", "tc-sub", {
			details: {
				runId: "run-xyz",
				results: [{ agent: "code-agent", sessionFile: "/sessions/child/session.jsonl" }],
			},
		}),
	];

	const result = pairToolCalls(entries);

	assert.equal(result.toolPairs.length, 1);
	const pair = result.toolPairs[0];
	assert.equal(pair?.observedLatencyMs, 10000);
	assert.equal(pair?.details?.runId, "run-xyz");
	assert.equal(pair?.details?.results?.[0]?.agent, "code-agent");
	assert.equal(pair?.details?.results?.[0]?.sessionFile, "/sessions/child/session.jsonl");
});

// ---------------------------------------------------------------------------
// computeMedian
// ---------------------------------------------------------------------------

test("computeMedian: returns null for empty array", () => {
	assert.equal(computeMedian([]), null);
});

test("computeMedian: returns the single value for a one-element array", () => {
	assert.equal(computeMedian([42]), 42);
});

test("computeMedian: returns the middle value for an odd-sized array", () => {
	assert.equal(computeMedian([3, 1, 2]), 2);
});

test("computeMedian: averages the two middle values for an even-sized array", () => {
	// 1, 100 → mid = 1 → (1 + 100) / 2 = 50.5
	assert.equal(computeMedian([1, 100]), 50.5);
	// 1, 2, 3, 4 → mid = 2 → (2 + 3) / 2 = 2.5
	assert.equal(computeMedian([1, 2, 3, 4]), 2.5);
});

test("computeMedian: sorts before computing (input order does not matter)", () => {
	// Unsorted: 100, 1 → sorted: 1, 100 → (1 + 100) / 2 = 50.5
	assert.equal(computeMedian([100, 1]), 50.5);
});

test("computeMedian and tokens-analyzer agree on the same even-sized latency sample", () => {
	// 1 000 ms and 100 000 ms.  The old tokens-analyzer formula would pick
	// latencies[Math.floor((2-1)/2)] = latencies[0] = 1000.
	// The correct average-of-two-middles formula must yield 50 500.
	const latencies = [1000, 100000];
	const median = computeMedian(latencies);
	assert.equal(median, 50500, "even-sized sample must average the two middle values");
	// CLI caller preserves null for empty, tokens caller coerces null to 0.
	assert.equal(computeMedian([]) ?? 0, 0, "tokens caller: empty yields 0 via ?? 0");
	assert.equal(computeMedian([]), null, "CLI caller: empty yields null");
});
