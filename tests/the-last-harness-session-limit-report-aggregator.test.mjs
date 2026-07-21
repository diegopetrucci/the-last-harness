import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { aggregateSessionUsage, decodeProjectDirName } = await jiti.import(
	"../extensions/the-last-harness/session-limit-report-aggregator.ts",
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_ROOT = "/sessions";
const PROJECT_DIR = "--Users-foo-my-project--";
const PROJECT_PATH = `${SESSIONS_ROOT}/${PROJECT_DIR}`;

const WIN_START_MS = Date.parse("2026-05-01T10:00:00.000Z");
const WIN_END_MS = Date.parse("2026-05-01T15:00:00.000Z");
const WINDOW = { startMs: WIN_START_MS, endMs: WIN_END_MS };

// ---------------------------------------------------------------------------
// Fixtures helpers
// ---------------------------------------------------------------------------

/** Build a session header entry. */
function sessionHeader({ id = "sess-001", name = "My session", cwd = "/Users/foo/my-project" } = {}) {
	return { type: "session", id, name, timestamp: "2026-05-01T10:00:00.000Z", cwd };
}

/** Build a model_change entry. */
function modelChange(provider, modelId) {
	return { type: "model_change", provider, modelId };
}

/** Build an assistant message entry with usage (real shape observed in actual tlh session files). */
function assistantMsg(timestampIso, { input = 100, output = 50, cacheRead = 0, cacheWrite = 0, costTotal = 0 } = {}) {
	return {
		type: "message",
		timestamp: timestampIso,
		message: {
			role: "assistant",
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: input + output + cacheRead + cacheWrite,
				cost: { total: costTotal },
			},
		},
	};
}

/** Build an assistant message entry WITHOUT usage data. */
function assistantMsgNoUsage(timestampIso) {
	return {
		type: "message",
		timestamp: timestampIso,
		message: { role: "assistant" },
	};
}

/** Build a user message entry. */
function userMsg(timestampIso) {
	return {
		type: "message",
		timestamp: timestampIso,
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	};
}

/** Timestamp just inside the window. */
const TS_INSIDE = "2026-05-01T12:00:00.000Z";
/** Timestamp at window start (boundary). */
const TS_AT_START = new Date(WIN_START_MS).toISOString();
/** Timestamp at window end (boundary). */
const TS_AT_END = new Date(WIN_END_MS).toISOString();
/** Timestamp just before window start. */
const TS_BEFORE = new Date(WIN_START_MS - 1).toISOString();
/** Timestamp just after window end. */
const TS_AFTER = new Date(WIN_END_MS + 1).toISOString();

/** A primary session file path. */
const PRIMARY_FILE = `${PROJECT_PATH}/20260501_abc123.jsonl`;
/** A subagent child session file path. */
const SUBAGENT_FILE = `${PROJECT_PATH}/20260501_abc123/run-001/run-1/session.jsonl`;

// ---------------------------------------------------------------------------
// decodeProjectDirName
// ---------------------------------------------------------------------------

test("decodeProjectDirName: decodes --…-- pattern to last segment", () => {
	assert.equal(decodeProjectDirName("--Users-foo-my-project--"), "project");
});

test("decodeProjectDirName: returns raw name when not --…-- pattern", () => {
	assert.equal(decodeProjectDirName("some-plain-dir"), "some-plain-dir");
});

test("decodeProjectDirName: handles single-component path", () => {
	assert.equal(decodeProjectDirName("--myproject--"), "myproject");
});

test("decodeProjectDirName: returns raw name for empty-ish pattern", () => {
	// "----" would decode to "" inner; should return raw.
	assert.equal(decodeProjectDirName("----"), "----");
});

// ---------------------------------------------------------------------------
// aggregateSessionUsage — basic aggregation
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: empty file list returns zero grand totals", () => {
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, []);
	assert.equal(result.rows.length, 0);
	assert.equal(result.grandTotals.totalTokens, 0);
	assert.equal(result.grandTotals.turns, 0);
	assert.deepEqual(result.perProviderTotals, []);
	assert.deepEqual(result.caveats, []);
});

test("aggregateSessionUsage: single file with one in-window assistant message", () => {
	const entries = [
		sessionHeader(),
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_INSIDE, { input: 100, output: 50 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);

	assert.equal(result.rows.length, 1);
	const row = result.rows[0];
	assert.equal(row.sessionId, "sess-001");
	assert.equal(row.sessionName, "My session");
	assert.equal(row.fileKind, "primary");
	assert.equal(row.windowTotals.inputTokens, 100);
	assert.equal(row.windowTotals.outputTokens, 50);
	assert.equal(row.windowTotals.totalTokens, 150);
	assert.equal(row.windowTotals.turns, 1);
	assert.equal(row.coverage.assistantMessages, 1);
	assert.equal(row.coverage.withUsage, 1);
	assert.equal(row.coverage.withoutUsage, 0);
	assert.equal(row.providerTotals.length, 1);
	assert.equal(row.providerTotals[0].provider, "anthropic");
	assert.equal(row.providerTotals[0].modelId, "claude-3-5-sonnet");

	assert.equal(result.grandTotals.totalTokens, 150);
	assert.equal(result.perProviderTotals.length, 1);
	assert.equal(result.perProviderTotals[0].provider, "anthropic");
});

// ---------------------------------------------------------------------------
// In-window boundary filtering
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: message at window start (startMs) is included", () => {
	const entries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_AT_START, { input: 10, output: 5 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.grandTotals.totalTokens, 15);
	assert.equal(result.rows[0].coverage.assistantMessages, 1);
});

test("aggregateSessionUsage: message at window end (endMs) is included", () => {
	const entries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_AT_END, { input: 10, output: 5 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.grandTotals.totalTokens, 15);
});

test("aggregateSessionUsage: message before window start is excluded", () => {
	const entries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_BEFORE, { input: 100, output: 50 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.grandTotals.totalTokens, 0);
	assert.equal(result.rows[0].coverage.assistantMessages, 0);
});

test("aggregateSessionUsage: message after window end is excluded", () => {
	const entries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_AFTER, { input: 100, output: 50 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.grandTotals.totalTokens, 0);
	assert.equal(result.rows[0].coverage.assistantMessages, 0);
});

// ---------------------------------------------------------------------------
// Provider switching mid-session
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: provider switch mid-session accumulates correctly", () => {
	const entries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_INSIDE, { input: 100, output: 50 }),
		modelChange("openai-codex", "gpt-5.5"),
		assistantMsg(TS_INSIDE, { input: 200, output: 80 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);

	const row = result.rows[0];
	assert.equal(row.providerTotals.length, 2);

	const anthropicPt = row.providerTotals.find((p) => p.provider === "anthropic");
	const codexPt = row.providerTotals.find((p) => p.provider === "openai-codex");
	assert.ok(anthropicPt, "anthropic provider totals should exist");
	assert.ok(codexPt, "openai-codex provider totals should exist");

	assert.equal(anthropicPt.usage.inputTokens, 100);
	assert.equal(anthropicPt.usage.outputTokens, 50);
	assert.equal(codexPt.usage.inputTokens, 200);
	assert.equal(codexPt.usage.outputTokens, 80);

	// Grand totals
	assert.equal(result.grandTotals.inputTokens, 300);
	assert.equal(result.grandTotals.outputTokens, 130);
	assert.equal(result.grandTotals.turns, 2);
});

test("aggregateSessionUsage: provider switch — model_change before window does not affect attribution", () => {
	// model_change before window; assistant message inside window should still pick up provider
	const entries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_BEFORE, { input: 99, output: 99 }), // out-of-window, ignored
		assistantMsg(TS_INSIDE, { input: 10, output: 5 }),   // in-window, should use anthropic
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].providerTotals.length, 1);
	assert.equal(result.rows[0].providerTotals[0].provider, "anthropic");
	assert.equal(result.grandTotals.totalTokens, 15);
});

// ---------------------------------------------------------------------------
// Sessions with no in-window usage
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: file with no in-window messages produces zero-total row", () => {
	const entries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_BEFORE, { input: 100, output: 50 }),
		assistantMsg(TS_AFTER, { input: 200, output: 80 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	// Row is still present (for coverage information) but with zero totals
	assert.equal(result.rows.length, 1);
	assert.equal(result.rows[0].windowTotals.totalTokens, 0);
	assert.equal(result.rows[0].coverage.assistantMessages, 0);
	assert.equal(result.grandTotals.totalTokens, 0);
});

// ---------------------------------------------------------------------------
// Subagent child session attribution (fileKind classification)
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: primary session file classified as primary", () => {
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries: [sessionHeader()], malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].fileKind, "primary");
});

test("aggregateSessionUsage: subagent child session classified as subagent-child", () => {
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: SUBAGENT_FILE, entries: [sessionHeader()], malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].fileKind, "subagent-child");
});

test("aggregateSessionUsage: subagent child usage counted separately (no double-counting)", () => {
	// Primary has 100 input, subagent child has 200 input. Grand total should be 300.
	const primaryEntries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_INSIDE, { input: 100, output: 0 }),
	];
	const subagentEntries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_INSIDE, { input: 200, output: 0 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries: primaryEntries, malformedLineCount: 0 },
		{ filePath: SUBAGENT_FILE, entries: subagentEntries, malformedLineCount: 0 },
	]);
	assert.equal(result.rows.length, 2);
	assert.equal(result.grandTotals.inputTokens, 300);
	// Rows sorted by totalTokens desc — subagent (200) first, primary (100) second
	assert.equal(result.rows[0].windowTotals.inputTokens, 200);
	assert.equal(result.rows[0].fileKind, "subagent-child");
	assert.equal(result.rows[1].windowTotals.inputTokens, 100);
	assert.equal(result.rows[1].fileKind, "primary");
});

// ---------------------------------------------------------------------------
// Missing-usage coverage counting
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: assistant messages without usage are counted in coverage", () => {
	const entries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_INSIDE, { input: 100, output: 50 }),
		assistantMsgNoUsage(TS_INSIDE),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	const row = result.rows[0];
	assert.equal(row.coverage.assistantMessages, 2);
	assert.equal(row.coverage.withUsage, 1);
	assert.equal(row.coverage.withoutUsage, 1);
	// A caveat is emitted
	assert.ok(
		result.caveats.some((c) => c.includes("1 of 2 in-window assistant message(s) had no usage data")),
		`expected coverage caveat, got: ${JSON.stringify(result.caveats)}`,
	);
});

test("aggregateSessionUsage: missing usage turns still increment windowTotals.turns", () => {
	const entries = [
		assistantMsgNoUsage(TS_INSIDE),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].windowTotals.turns, 1);
	assert.equal(result.rows[0].windowTotals.totalTokens, 0);
});

// ---------------------------------------------------------------------------
// Malformed lines caveat
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: malformed lines produce a caveat", () => {
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries: [], malformedLineCount: 3 },
	]);
	assert.ok(
		result.caveats.some((c) => c.includes("3 malformed line(s) skipped")),
		`expected malformed caveat, got: ${JSON.stringify(result.caveats)}`,
	);
});

// ---------------------------------------------------------------------------
// scanCaveats forwarding
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: scan caveats are forwarded into result caveats", () => {
	const scanCaveats = ["Could not stat /some/file: EACCES"];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [], scanCaveats);
	assert.ok(result.caveats.includes("Could not stat /some/file: EACCES"));
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: rows are sorted by totalTokens descending", () => {
	const file1 = `${PROJECT_PATH}/file1.jsonl`;
	const file2 = `${PROJECT_PATH}/file2.jsonl`;
	const file3 = `${PROJECT_PATH}/file3.jsonl`;

	const makeEntries = (tokens) => [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_INSIDE, { input: tokens, output: 0 }),
	];

	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: file1, entries: makeEntries(10), malformedLineCount: 0 },
		{ filePath: file2, entries: makeEntries(30), malformedLineCount: 0 },
		{ filePath: file3, entries: makeEntries(20), malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].windowTotals.inputTokens, 30);
	assert.equal(result.rows[1].windowTotals.inputTokens, 20);
	assert.equal(result.rows[2].windowTotals.inputTokens, 10);
});

test("aggregateSessionUsage: perProviderTotals are sorted by totalTokens descending", () => {
	const entries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_INSIDE, { input: 10, output: 5 }),
		modelChange("openai-codex", "gpt-5.5"),
		assistantMsg(TS_INSIDE, { input: 200, output: 100 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.perProviderTotals[0].provider, "openai-codex");
	assert.equal(result.perProviderTotals[1].provider, "anthropic");
});

// ---------------------------------------------------------------------------
// Provider tracking — unknown fallback
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: assistant message with no prior model_change uses 'unknown' provider", () => {
	const entries = [
		assistantMsg(TS_INSIDE, { input: 50, output: 20 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].providerTotals.length, 1);
	assert.equal(result.rows[0].providerTotals[0].provider, "unknown");
});

// ---------------------------------------------------------------------------
// Multiple files — per-provider totals aggregated across files
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: per-provider totals accumulate across multiple files", () => {
	const entries1 = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_INSIDE, { input: 100, output: 50 }),
	];
	const entries2 = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		assistantMsg(TS_INSIDE, { input: 200, output: 80 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: `${PROJECT_PATH}/file1.jsonl`, entries: entries1, malformedLineCount: 0 },
		{ filePath: `${PROJECT_PATH}/file2.jsonl`, entries: entries2, malformedLineCount: 0 },
	]);
	assert.equal(result.perProviderTotals.length, 1);
	assert.equal(result.perProviderTotals[0].provider, "anthropic");
	assert.equal(result.perProviderTotals[0].usage.inputTokens, 300);
	assert.equal(result.perProviderTotals[0].usage.outputTokens, 130);
});

// ---------------------------------------------------------------------------
// Project label
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: projectLabel is derived from escaped project dir", () => {
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries: [], malformedLineCount: 0 },
	]);
	// --Users-foo-my-project-- → last segment → "project"
	assert.equal(result.rows[0].projectLabel, "project");
});

// ---------------------------------------------------------------------------
// User messages are not counted
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: user messages are not counted in coverage or totals", () => {
	const entries = [
		modelChange("anthropic", "claude-3-5-sonnet"),
		userMsg(TS_INSIDE),
		assistantMsg(TS_INSIDE, { input: 50, output: 20 }),
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].coverage.assistantMessages, 1);
	assert.equal(result.grandTotals.totalTokens, 70);
});

// ---------------------------------------------------------------------------
// session_info name resolution
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: session_info name wins over session header name", () => {
	const entries = [
		{ type: "session", id: "sess-001", name: "Header Name", timestamp: "2026-05-01T10:00:00.000Z" },
		{ type: "session_info", name: "Renamed Session" },
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].sessionName, "Renamed Session");
});

test("aggregateSessionUsage: later session_info name wins over earlier one", () => {
	const entries = [
		{ type: "session", id: "sess-001", name: "Header Name", timestamp: "2026-05-01T10:00:00.000Z" },
		{ type: "session_info", name: "First Rename" },
		{ type: "session_info", name: "Second Rename" },
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].sessionName, "Second Rename");
});

test("aggregateSessionUsage: header name used when no session_info name present", () => {
	const entries = [
		{ type: "session", id: "sess-001", name: "Only Header Name", timestamp: "2026-05-01T10:00:00.000Z" },
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].sessionName, "Only Header Name");
});

// ---------------------------------------------------------------------------
// cwd-derived project label
// ---------------------------------------------------------------------------

test("aggregateSessionUsage: projectLabel uses basename of cwd from session header", () => {
	const entries = [
		{ type: "session", id: "sess-001", timestamp: "2026-05-01T10:00:00.000Z", cwd: "/Users/foo/real-project-name" },
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].projectLabel, "real-project-name");
});

test("aggregateSessionUsage: projectLabel uses basename of cwd from session_info when no session header cwd", () => {
	const entries = [
		{ type: "session", id: "sess-001", timestamp: "2026-05-01T10:00:00.000Z" },
		{ type: "session_info", cwd: "/Users/foo/project-from-info" },
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	assert.equal(result.rows[0].projectLabel, "project-from-info");
});

test("aggregateSessionUsage: projectLabel falls back to dir-name decode when no cwd in any entry", () => {
	const entries = [
		{ type: "session", id: "sess-001", timestamp: "2026-05-01T10:00:00.000Z" },
	];
	const result = aggregateSessionUsage(WINDOW, SESSIONS_ROOT, [
		{ filePath: PRIMARY_FILE, entries, malformedLineCount: 0 },
	]);
	// --Users-foo-my-project-- → last segment → "project"
	assert.equal(result.rows[0].projectLabel, "project");
});
