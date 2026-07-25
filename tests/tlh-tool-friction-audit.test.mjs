import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createJiti } from "jiti";

const repoRoot = resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url);
const {
	auditToolFriction,
	parseArgs,
	LARGE_OUTPUT_THRESHOLD_CHARACTERS,
} = await jiti.import("../scripts/tlh-tool-friction-audit.mts");
const cliScript = join(repoRoot, "scripts", "tlh-tool-friction-audit.mjs");

const WINDOW_START = "2026-07-25T10:00:00.000Z";
const WINDOW_END = "2026-07-25T12:00:00.000Z";
const WINDOW_OUTSIDE = "2026-07-25T12:00:00.001Z";
const DUPLICATE_TIMESTAMP = "2026-07-25T10:15:00.000Z";
const SECRET_PATH = "/Users/private/repo/secret.txt";
const SECRET_TEXT = "TOP SECRET TOOL RESULT";

function createSessionsRoot() {
	return mkdtempSync(join(tmpdir(), "tlh-tool-friction-audit-"));
}

function sessionFile(root, projectName, fileName, lines) {
	const projectDir = join(root, projectName);
	mkdirSync(projectDir, { recursive: true });
	const filePath = join(projectDir, fileName);
	writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
	return filePath;
}

function messageLine({
	timestamp,
	toolName,
	text,
	isError = false,
	role = "toolResult",
}) {
	return JSON.stringify({
		type: "message",
		timestamp,
		message: {
			role,
			toolName,
			isError,
			content: [{ type: "text", text }],
		},
	});
}

function fixtureData() {
	const rootA = createSessionsRoot();
	const rootB = createSessionsRoot();
	const largeOutput = "é".repeat(LARGE_OUTPUT_THRESHOLD_CHARACTERS);
	const duplicatePathMissText = `ENOENT: no such file or directory, open ${SECRET_PATH}`;

	sessionFile(rootA, "--Users-private-project-a--", "2026-07-25T10-00-00Z_a.jsonl", [
		JSON.stringify({ type: "session", id: "session-a" }),
		messageLine({ timestamp: DUPLICATE_TIMESTAMP, toolName: "read", isError: true, text: duplicatePathMissText }),
		messageLine({ timestamp: "2026-07-25T10:20:00.000Z", toolName: "edit", isError: true, text: "Found 2 occurrences of the target block" }),
		messageLine({ timestamp: "2026-07-25T10:25:00.000Z", toolName: "edit", isError: true, text: "Validation failed for tool \"edit\" while applying the patch" }),
		messageLine({ timestamp: "2026-07-25T10:30:00.000Z", toolName: "edit", isError: true, text: "Could not find the exact text to replace" }),
		messageLine({ timestamp: "2026-07-25T10:35:00.000Z", toolName: "bash", isError: true, text: "python: command not found" }),
		"not valid json",
	]);

	sessionFile(rootB, "--Users-private-project-b--", "2026-07-25T10-00-00Z_b.jsonl", [
		JSON.stringify({ type: "session", id: "session-b" }),
		messageLine({ timestamp: DUPLICATE_TIMESTAMP, toolName: "read", isError: true, text: duplicatePathMissText }),
		messageLine({ timestamp: "2026-07-25T10:40:00.000Z", toolName: "grep", isError: true, text: "regex parse error: repetition operator missing expression" }),
		messageLine({ timestamp: "2026-07-25T10:45:00.000Z", toolName: "find", isError: true, text: "rtk: rtk find does not support compound predicates or actions" }),
		messageLine({ timestamp: "2026-07-25T10:50:00.000Z", toolName: "bash", isError: false, text: largeOutput }),
		messageLine({ timestamp: "2026-07-25T10:55:00.000Z", toolName: "ls", isError: false, text: "safe output 1" }),
		messageLine({ timestamp: "2026-07-25T11:00:00.000Z", toolName: "grep", isError: false, text: `normal output mentioning ${SECRET_TEXT}` }),
		messageLine({ timestamp: WINDOW_OUTSIDE, toolName: "read", isError: true, text: "ENOENT outside the window" }),
	]);

	return { rootA, rootB, largeOutput };
}

test("auditToolFriction aggregates all six friction classes, edit subtypes, malformed lines, and deduped logical results", async () => {
	const { rootA, rootB, largeOutput } = fixtureData();

	const result = await auditToolFriction({
		sessionRoots: [rootA, rootB],
		startIso: WINDOW_START,
		endIso: WINDOW_END,
	});

	assert.equal(result.window.startIso, WINDOW_START);
	assert.equal(result.window.endIso, WINDOW_END);
	assert.equal(result.inputs.sessionRootCount, 2);
	assert.equal(result.scan.filesDiscovered, 2);
	assert.equal(result.scan.filesParsed, 2);
	assert.equal(result.scan.parseFailures, 0);
	assert.equal(result.scan.malformedLines, 1);
	assert.equal(result.toolResults.rawInWindow, 11);
	assert.equal(result.toolResults.uniqueInWindow, 10);
	assert.equal(result.toolResults.duplicateLogicalResultsSkipped, 1);
	assert.equal(result.toolResults.errorResults, 7);

	assert.deepEqual(result.friction.pathMisses, {
		count: 1,
		ratePer1000ToolResults: 100,
		toolResultsDenominator: 10,
	});
	assert.equal(result.friction.editFailures.count, 3);
	assert.equal(result.friction.editFailures.subtypes["non-unique"].count, 1);
	assert.equal(result.friction.editFailures.subtypes.validation.count, 1);
	assert.equal(result.friction.editFailures.subtypes["not-found"].count, 1);
	assert.equal(result.friction.missingPython.count, 1);
	assert.equal(result.friction.invalidRegex.count, 1);
	assert.equal(result.friction.unsupportedCompoundFind.count, 1);
	assert.equal(result.friction.largeOutput.count, 1);
	assert.equal(result.friction.largeOutput.thresholdCharacters, 50_000);
	assert.equal(result.friction.largeOutput.thresholdLabel, "50,000 characters");
	assert.equal(result.friction.largeOutput.totalCharacters, largeOutput.length);
	assert.equal(result.friction.largeOutput.totalUtf8Bytes, Buffer.byteLength(largeOutput, "utf8"));
	assert.equal(result.friction.largeOutput.maxCharacters, largeOutput.length);
	assert.equal(result.friction.largeOutput.maxUtf8Bytes, Buffer.byteLength(largeOutput, "utf8"));
	assert.ok(result.friction.largeOutput.totalUtf8Bytes > result.friction.largeOutput.totalCharacters);

	assert.deepEqual(
		result.toolBreakdown.map((entry) => [entry.toolName, entry.uniqueToolResults]),
		[
			["edit", 3],
			["bash", 2],
			["grep", 2],
			["find", 1],
			["ls", 1],
			["read", 1],
		],
	);
});

test("auditToolFriction output stays aggregate-only and does not emit raw text, paths, or roots", async () => {
	const { rootA, rootB } = fixtureData();
	const result = await auditToolFriction({
		sessionRoots: [rootA, rootB],
		startIso: WINDOW_START,
		endIso: WINDOW_END,
	});
	const json = JSON.stringify(result);

	assert.doesNotMatch(json, /TOP SECRET TOOL RESULT/);
	assert.doesNotMatch(json, /Users\/private\/repo/);
	assert.doesNotMatch(json, /tlh-tool-friction-audit-/);
	assert.doesNotMatch(json, /ENOENT outside the window/);
});

test("parseArgs requires explicit session roots and inclusive ISO bounds", () => {
	assert.deepEqual(parseArgs([
		"--session-root",
		"/tmp/a",
		"--session-root=/tmp/b",
		"--start",
		WINDOW_START,
		"--end",
		WINDOW_END,
	]), {
		sessionRoots: ["/tmp/a", "/tmp/b"],
		startIso: WINDOW_START,
		endIso: WINDOW_END,
		help: false,
	});
	assert.throws(() => parseArgs(["--session-root", "/tmp/a", "--start", WINDOW_START]), /--end is required/);
	assert.throws(() => parseArgs(["--start", WINDOW_START, "--end", WINDOW_END]), /At least one --session-root is required/);
});

test("CLI emits aggregate-only JSON for explicit inputs and window", () => {
	const { rootA, rootB } = fixtureData();
	const result = spawnSync(process.execPath, [
		cliScript,
		"--session-root",
		rootA,
		"--session-root",
		rootB,
		"--start",
		WINDOW_START,
		"--end",
		WINDOW_END,
	], {
		cwd: repoRoot,
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	const parsed = JSON.parse(result.stdout);
	assert.equal(parsed.window.inclusive, true);
	assert.equal(parsed.toolResults.uniqueInWindow, 10);
	assert.equal(parsed.friction.largeOutput.thresholdLabel, "50,000 characters");
	assert.doesNotMatch(result.stdout, /TOP SECRET TOOL RESULT/);
	assert.doesNotMatch(result.stdout, /Users\/private\/repo/);
});
