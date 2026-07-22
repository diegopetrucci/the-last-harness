import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveSessionLimitWindow, discoverSessionFiles, parseSessionJsonl } = await jiti.import(
	"../extensions/the-last-harness/session-limit-report-scan.ts",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-05-19T19:00:00.000Z");
const RESETS_AT = "2026-05-19T20:00:00.000Z";
const RESETS_AT_MS = Date.parse(RESETS_AT);
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Build a minimal anthropic snapshot. */
function anthropicSnapshot(options = {}) {
	return {
		provider: "anthropic",
		fetchedAt: NOW_MS,
		windows: {
			session: {
				key: "five_hour",
				label: "session",
				used: options.used ?? 50,
				limit: options.limit ?? 100,
				resetsAt: options.resetsAt ?? RESETS_AT,
				durationMs: options.durationMs,
			},
		},
	};
}

/** Build a minimal openai-codex snapshot. */
function codexSnapshot(options = {}) {
	return {
		provider: "openai-codex",
		fetchedAt: NOW_MS,
		windows: {
			session: {
				key: "primary_window",
				label: "session",
				used: options.used ?? 25,
				limit: options.limit ?? 100,
				resetsAt: options.resetsAt ?? RESETS_AT,
				durationMs: options.durationMs,
			},
		},
	};
}

/** Create a temp sessions root dir with a given structure. */
function makeTempSessionsRoot() {
	return mkdtempSync(join(tmpdir(), "tlh-scan-test-"));
}

/**
 * Write a file at `path`, then set its mtime to `mtimeMs`.
 * Parent directories are created if needed.
 */
function writeWithMtime(filePath, content, mtimeMs) {
	const mtimeSec = mtimeMs / 1000;
	writeFileSync(filePath, content, "utf8");
	utimesSync(filePath, mtimeSec, mtimeSec);
}

/**
 * Build a minimal valid session JSONL header line.
 */
function sessionHeader(id = "sess-001") {
	return JSON.stringify({ type: "session", id, timestamp: "2026-05-19T19:00:00.000Z" });
}

/**
 * Build a minimal assistant message entry line.
 */
function assistantEntry(id = "msg-001", usage = {}) {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-05-19T19:01:00.000Z",
		message: {
			role: "assistant",
			provider: "anthropic",
			model: "claude-opus-4-5",
			usage: { input: usage.input ?? 100, output: usage.output ?? 50 },
		},
	});
}

// ---------------------------------------------------------------------------
// resolveSessionLimitWindow — anthropic snapshot
// ---------------------------------------------------------------------------

test("resolveSessionLimitWindow: anthropic snapshot with explicit durationMs", () => {
	const snapshot = anthropicSnapshot({ durationMs: FIVE_HOURS_MS });
	const window = resolveSessionLimitWindow(snapshot, NOW_MS);

	assert.equal(window.source, "snapshot");
	assert.equal(window.endMs, RESETS_AT_MS);
	assert.equal(window.startMs, RESETS_AT_MS - FIVE_HOURS_MS);
});

test("resolveSessionLimitWindow: anthropic snapshot uses default 5h when durationMs is missing", () => {
	const snapshot = anthropicSnapshot(); // no durationMs
	const window = resolveSessionLimitWindow(snapshot, NOW_MS);

	assert.equal(window.source, "snapshot");
	assert.equal(window.endMs, RESETS_AT_MS);
	assert.equal(window.startMs, RESETS_AT_MS - FIVE_HOURS_MS);
});

test("resolveSessionLimitWindow: anthropic snapshot with custom durationMs (2h)", () => {
	const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
	const snapshot = anthropicSnapshot({ durationMs: TWO_HOURS_MS });
	const window = resolveSessionLimitWindow(snapshot, NOW_MS);

	assert.equal(window.source, "snapshot");
	assert.equal(window.endMs, RESETS_AT_MS);
	assert.equal(window.startMs, RESETS_AT_MS - TWO_HOURS_MS);
});

// ---------------------------------------------------------------------------
// resolveSessionLimitWindow — openai-codex snapshot
// ---------------------------------------------------------------------------

test("resolveSessionLimitWindow: openai-codex snapshot with explicit durationMs", () => {
	const snapshot = codexSnapshot({ durationMs: FIVE_HOURS_MS });
	const window = resolveSessionLimitWindow(snapshot, NOW_MS);

	assert.equal(window.source, "snapshot");
	assert.equal(window.endMs, RESETS_AT_MS);
	assert.equal(window.startMs, RESETS_AT_MS - FIVE_HOURS_MS);
});

test("resolveSessionLimitWindow: openai-codex snapshot uses default 5h when durationMs is missing", () => {
	const snapshot = codexSnapshot(); // no durationMs
	const window = resolveSessionLimitWindow(snapshot, NOW_MS);

	assert.equal(window.source, "snapshot");
	assert.equal(window.endMs, RESETS_AT_MS);
	assert.equal(window.startMs, RESETS_AT_MS - FIVE_HOURS_MS);
});

// ---------------------------------------------------------------------------
// resolveSessionLimitWindow — fallback cases
// ---------------------------------------------------------------------------

test("resolveSessionLimitWindow: fallback when snapshot is undefined", () => {
	const window = resolveSessionLimitWindow(undefined, NOW_MS);

	assert.equal(window.source, "fallback");
	assert.equal(window.endMs, NOW_MS);
	assert.equal(window.startMs, NOW_MS - FIVE_HOURS_MS);
});

test("resolveSessionLimitWindow: fallback when snapshot has no resetsAt", () => {
	const snapshot = anthropicSnapshot({ resetsAt: undefined });
	delete snapshot.windows.session.resetsAt;
	const window = resolveSessionLimitWindow(snapshot, NOW_MS);

	assert.equal(window.source, "fallback");
	assert.equal(window.endMs, NOW_MS);
	assert.equal(window.startMs, NOW_MS - FIVE_HOURS_MS);
});

test("resolveSessionLimitWindow: fallback when resetsAt is not a valid date", () => {
	const snapshot = anthropicSnapshot({ resetsAt: "not-a-date" });
	const window = resolveSessionLimitWindow(snapshot, NOW_MS);

	assert.equal(window.source, "fallback");
	assert.equal(window.endMs, NOW_MS);
	assert.equal(window.startMs, NOW_MS - FIVE_HOURS_MS);
});

test("resolveSessionLimitWindow: fallback when snapshot has no session window", () => {
	const snapshot = { provider: "anthropic", fetchedAt: NOW_MS, windows: {} };
	const window = resolveSessionLimitWindow(snapshot, NOW_MS);

	assert.equal(window.source, "fallback");
	assert.equal(window.endMs, NOW_MS);
	assert.equal(window.startMs, NOW_MS - FIVE_HOURS_MS);
});

test("resolveSessionLimitWindow: fallback uses Date.now() when nowMs is omitted", () => {
	const before = Date.now();
	const window = resolveSessionLimitWindow(undefined);
	const after = Date.now();

	assert.equal(window.source, "fallback");
	assert.ok(window.endMs >= before && window.endMs <= after, "endMs should be close to Date.now()");
	assert.equal(window.startMs, window.endMs - FIVE_HOURS_MS);
});

// ---------------------------------------------------------------------------
// discoverSessionFiles — mtime pruning
// ---------------------------------------------------------------------------

test("discoverSessionFiles: includes files with mtime >= windowStartMs", () => {
	const root = makeTempSessionsRoot();
	const projDir = join(root, "--Users-foo-project--");
	mkdirSync(projDir, { recursive: true });

	const freshFile = join(projDir, "2026-01-01T00:00:00Z_abc.jsonl");
	const windowStartMs = NOW_MS - FIVE_HOURS_MS;
	// mtime = exactly windowStartMs (should be included)
	writeWithMtime(freshFile, sessionHeader() + "\n", windowStartMs);

	const result = discoverSessionFiles(root, windowStartMs);

	assert.ok(result.files.includes(freshFile), "fresh file should be included");
	assert.equal(result.caveats.length, 0);
});

test("discoverSessionFiles: excludes files with mtime < windowStartMs", () => {
	const root = makeTempSessionsRoot();
	const projDir = join(root, "--Users-foo-project--");
	mkdirSync(projDir, { recursive: true });

	const staleFile = join(projDir, "2025-01-01T00:00:00Z_old.jsonl");
	const windowStartMs = NOW_MS - FIVE_HOURS_MS;
	// mtime = 1 ms before window start (should be excluded)
	writeWithMtime(staleFile, sessionHeader() + "\n", windowStartMs - 1);

	const result = discoverSessionFiles(root, windowStartMs);

	assert.ok(!result.files.includes(staleFile), "stale file should be excluded");
});

test("discoverSessionFiles: returns empty array when root is empty", () => {
	const root = makeTempSessionsRoot();
	const result = discoverSessionFiles(root, NOW_MS);

	assert.deepEqual(result.files, []);
	assert.deepEqual(result.caveats, []);
});

test("discoverSessionFiles: returns caveat when root does not exist", () => {
	const result = discoverSessionFiles("/nonexistent/sessions/root", NOW_MS);

	assert.deepEqual(result.files, []);
	assert.equal(result.caveats.length, 1);
	assert.ok(result.caveats[0].includes("Could not read sessions root"), result.caveats[0]);
});

// ---------------------------------------------------------------------------
// discoverSessionFiles — directory layout
// ---------------------------------------------------------------------------

test("discoverSessionFiles: discovers primary session files at <proj>/<file>.jsonl", () => {
	const root = makeTempSessionsRoot();
	const projDir = join(root, "--Users-foo-project--");
	mkdirSync(projDir, { recursive: true });

	const sessionFile = join(projDir, "2026-05-19T15:00:00Z_uuid1.jsonl");
	writeWithMtime(sessionFile, sessionHeader() + "\n", NOW_MS);

	const result = discoverSessionFiles(root, NOW_MS - FIVE_HOURS_MS);

	assert.ok(result.files.includes(sessionFile));
});

test("discoverSessionFiles: discovers subagent child session at <proj>/<parent>/<runId>/run-N/session.jsonl", () => {
	const root = makeTempSessionsRoot();
	const projDir = join(root, "--Users-foo-project--");
	const subagentDir = join(projDir, "2026-05-19T15:00:00Z_uuid1", "runid123", "run-1");
	mkdirSync(subagentDir, { recursive: true });

	const childSession = join(subagentDir, "session.jsonl");
	writeWithMtime(childSession, sessionHeader("child-sess") + "\n", NOW_MS);

	const result = discoverSessionFiles(root, NOW_MS - FIVE_HOURS_MS);

	assert.ok(result.files.includes(childSession), "child session should be discovered");
});

test("discoverSessionFiles: excludes subagent-artifacts subtree", () => {
	const root = makeTempSessionsRoot();
	const projDir = join(root, "--Users-foo-project--");
	const artifactsDir = join(projDir, "subagent-artifacts");
	mkdirSync(artifactsDir, { recursive: true });

	// A .jsonl file inside subagent-artifacts — should NOT be collected.
	const artifactFile = join(artifactsDir, "some-output.jsonl");
	writeWithMtime(artifactFile, '{"type":"data"}\n', NOW_MS);

	const result = discoverSessionFiles(root, NOW_MS - FIVE_HOURS_MS);

	assert.ok(!result.files.includes(artifactFile), "subagent-artifacts files should be excluded");
	assert.deepEqual(result.caveats, []);
});

test("discoverSessionFiles: discovers files across multiple project dirs", () => {
	const root = makeTempSessionsRoot();
	const proj1 = join(root, "--Users-foo-proj1--");
	const proj2 = join(root, "--Users-bar-proj2--");
	mkdirSync(proj1, { recursive: true });
	mkdirSync(proj2, { recursive: true });

	const file1 = join(proj1, "2026-05-19T15:00:00Z_a.jsonl");
	const file2 = join(proj2, "2026-05-19T16:00:00Z_b.jsonl");
	writeWithMtime(file1, sessionHeader("s1") + "\n", NOW_MS);
	writeWithMtime(file2, sessionHeader("s2") + "\n", NOW_MS);

	const result = discoverSessionFiles(root, NOW_MS - FIVE_HOURS_MS);

	assert.ok(result.files.includes(file1));
	assert.ok(result.files.includes(file2));
});

// ---------------------------------------------------------------------------
// parseSessionJsonl — basic parsing
// ---------------------------------------------------------------------------

test("parseSessionJsonl: parses a well-formed session file", async () => {
	const root = makeTempSessionsRoot();
	const filePath = join(root, "session.jsonl");
	const content = [
		sessionHeader("sess-1"),
		assistantEntry("msg-1", { input: 200, output: 100 }),
		"",
	].join("\n");
	writeFileSync(filePath, content, "utf8");

	const result = await parseSessionJsonl(filePath);

	assert.equal(result.entries.length, 2);
	assert.equal(result.malformedLineCount, 0);
	assert.equal(result.entries[0].type, "session");
	assert.equal(result.entries[1].type, "message");
});

test("parseSessionJsonl: skips malformed lines and counts them", async () => {
	const root = makeTempSessionsRoot();
	const filePath = join(root, "session.jsonl");
	const content = [
		sessionHeader("sess-2"),
		"this is not json {{{",
		assistantEntry("msg-2"),
		"null",         // valid JSON but not an object with type
		"[1,2,3]",     // array — no type string field
		'{"no-type": true}', // object but no `type` string
		assistantEntry("msg-3"),
	].join("\n");
	writeFileSync(filePath, content, "utf8");

	const result = await parseSessionJsonl(filePath);

	assert.equal(result.malformedLineCount, 4, "four malformed/invalid lines expected");
	assert.equal(result.entries.length, 3, "three valid entries expected");
});

test("parseSessionJsonl: empty lines are not counted as malformed", async () => {
	const root = makeTempSessionsRoot();
	const filePath = join(root, "session.jsonl");
	const content = "\n\n" + sessionHeader("sess-3") + "\n\n";
	writeFileSync(filePath, content, "utf8");

	const result = await parseSessionJsonl(filePath);

	assert.equal(result.entries.length, 1);
	assert.equal(result.malformedLineCount, 0);
});

test("parseSessionJsonl: throws when file cannot be read", async () => {
	await assert.rejects(
		() => parseSessionJsonl("/nonexistent/path/session.jsonl"),
		(error) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes("Could not read session file"), error.message);
			return true;
		},
	);
});

test("parseSessionJsonl: preserves message.usage on assistant entries", async () => {
	const root = makeTempSessionsRoot();
	const filePath = join(root, "session.jsonl");
	const usage = { input: 300, output: 150 };
	writeFileSync(filePath, sessionHeader() + "\n" + assistantEntry("msg-u", usage) + "\n", "utf8");

	const result = await parseSessionJsonl(filePath);

	const msgEntry = result.entries.find((entry) => entry.type === "message");
	assert.ok(msgEntry !== undefined);
	const message = msgEntry.message;
	assert.ok(message !== null && typeof message === "object");
	const messageUsage = message.usage;
	assert.ok(messageUsage !== null && typeof messageUsage === "object");
	assert.equal(messageUsage.input, 300);
	assert.equal(messageUsage.output, 150);
});

test("parseSessionJsonl: parses a completely empty file without errors", async () => {
	const root = makeTempSessionsRoot();
	const filePath = join(root, "empty.jsonl");
	writeFileSync(filePath, "", "utf8");

	const result = await parseSessionJsonl(filePath);

	assert.equal(result.entries.length, 0);
	assert.equal(result.malformedLineCount, 0);
});
