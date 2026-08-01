import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";

import { makeTempDir } from "./test-fixture-helpers.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const sessionsScript = join(repoRoot, "scripts", "tlh-sessions.mjs");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeAgentFixture(t, label = "tlh-sessions-test-") {
	const root = makeTempDir(label, t);
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	return { root, agentDir, sessionsDir };
}

function sessionHeaderLine(id = "sess-001", cwd = "/workspace/my-project") {
	return JSON.stringify({
		type: "session",
		version: 1,
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
	});
}

function assistantLine(timestamp, toolCalls = []) {
	const content = toolCalls.map(({ toolCallId, toolName }) => ({
		type: "toolCall",
		toolCallId,
		toolName,
	}));
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content,
			timestamp,
		},
	});
}

function toolResultLine(timestamp, toolCallId, { isError = false, toolName = "bash" } = {}) {
	return JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			isError,
			content: [{ type: "text", text: "ok" }],
			timestamp,
		},
	});
}

function writeSessionFile(sessionsDir, slug, filename, lines) {
	const dir = join(sessionsDir, slug);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, filename);
	writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
	return filePath;
}

function runSessions(agentDir, extraArgs = []) {
	return spawnSync(
		process.execPath,
		[sessionsScript, "--agent-dir", agentDir, ...extraArgs],
		{ encoding: "utf8", cwd: repoRoot },
	);
}

function parseJsonOutput(result) {
	assert.equal(result.status, 0, `stderr: ${result.stderr}`);
	const parsed = JSON.parse(result.stdout);
	return parsed;
}

// ---------------------------------------------------------------------------
// Tests: JSON validity and required fields
// ---------------------------------------------------------------------------

test("tlh-sessions: per-session mode emits valid JSON with required top-level fields", (t) => {
	const { agentDir } = makeAgentFixture(t);
	const result = runSessions(agentDir);
	const output = parseJsonOutput(result);

	assert.equal(output.schemaVersion, "1");
	assert.equal(output.mode, "per-session");
	assert.ok(typeof output.generatedAt === "string", "generatedAt must be a string");
	assert.ok(output.timingQualityNote.includes("observedLatencyMs"), "timingQualityNote must mention observedLatencyMs");
	assert.ok(output.timingQualityNote.includes("wall-clock"), "timingQualityNote must mention wall-clock");
	assert.ok(typeof output.provenance === "object", "provenance must be present");
	assert.ok(typeof output.coverage === "object", "coverage must be present");
	assert.ok(Array.isArray(output.sessions), "sessions must be an array");
	assert.ok("filesScanned" in output.coverage, "coverage.filesScanned must be present");
});

test("tlh-sessions: per-tool mode emits valid JSON with required top-level fields", (t) => {
	const { agentDir } = makeAgentFixture(t);
	const result = runSessions(agentDir, ["--mode", "per-tool"]);
	const output = parseJsonOutput(result);

	assert.equal(output.schemaVersion, "1");
	assert.equal(output.mode, "per-tool");
	assert.ok(typeof output.generatedAt === "string");
	assert.ok(output.timingQualityNote.includes("observedLatencyMs"));
	assert.ok(output.timingQualityNote.includes("wall-clock"));
	assert.ok(typeof output.provenance === "object");
	assert.ok(typeof output.coverage === "object");
	assert.ok(Array.isArray(output.tools), "tools must be an array");
});

// ---------------------------------------------------------------------------
// Tests: default privacy (no paths, no cwd)
// ---------------------------------------------------------------------------

test("tlh-sessions: default output contains no raw file paths", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);
	writeSessionFile(sessionsDir, "my-project-slug", "session.jsonl", [
		sessionHeaderLine("sess-default", "/home/user/my-project"),
		assistantLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-1", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-1"),
	]);

	const result = runSessions(agentDir);
	const output = parseJsonOutput(result);

	// provenance must always contain the non-identifying required fields
	assert.equal(output.provenance.toolName, "tlh-sessions", "provenance.toolName must be set");
	// Fix 8: --agent-dir was passed, so profileSource must be "flag"
	assert.equal(output.provenance.profileSource, "flag", "profileSource must be 'flag' when --agent-dir is passed");
	assert.ok(typeof output.provenance.profileId === "string" && output.provenance.profileId.length === 12, "provenance.profileId must be 12-char hex");
	// provenance must not contain agentDir or sessionsDir in default mode
	assert.ok(!("agentDir" in output.provenance), "provenance.agentDir must not appear in default output");
	assert.ok(!("sessionsDir" in output.provenance), "provenance.sessionsDir must not appear in default output");

	// No session record should contain a filePath or raw cwd
	assert.equal(output.sessions.length, 1);
	const session = output.sessions[0];
	assert.ok(!("filePath" in session), "filePath must not appear in default output");
	assert.ok(!("projectLabel" in session), "projectLabel must not appear in default output");
	assert.ok(!("subagentCorrelations" in session), "subagentCorrelations array must not appear in default output");

	// sessionId and startedAt are safe metadata — they must be present
	assert.equal(session.sessionId, "sess-default");
	assert.ok(typeof session.startedAt === "string");
});

test("tlh-sessions: default per-tool output has no path fields", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);
	writeSessionFile(sessionsDir, "my-project-slug", "session.jsonl", [
		sessionHeaderLine(),
		assistantLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-1", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-1"),
	]);

	const result = runSessions(agentDir, ["--mode", "per-tool"]);
	const output = parseJsonOutput(result);

	// provenance must always contain the non-identifying required fields
	assert.equal(output.provenance.toolName, "tlh-sessions");
	assert.ok(typeof output.provenance.profileId === "string" && output.provenance.profileId.length === 12);
	assert.ok(!("agentDir" in output.provenance), "provenance.agentDir must not appear in default per-tool output");
	assert.ok(!("sessionsDir" in output.provenance), "provenance.sessionsDir must not appear in default per-tool output");
	assert.ok(Array.isArray(output.tools));
	assert.equal(output.tools.length, 1);
	const tool = output.tools[0];
	assert.equal(tool.toolName, "bash");
	assert.ok(!("filePath" in tool), "tool records must not have filePath");
});

// ---------------------------------------------------------------------------
// Tests: --include-paths enables path fields
// ---------------------------------------------------------------------------

test("tlh-sessions: --include-paths adds filePath, projectLabel, and provenance", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);
	writeSessionFile(sessionsDir, "my-project-slug", "session.jsonl", [
		sessionHeaderLine("sess-paths", "/home/user/my-project"),
		assistantLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-1", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-1"),
	]);

	const result = runSessions(agentDir, ["--include-paths"]);
	const output = parseJsonOutput(result);

	// provenance must contain paths
	assert.ok(typeof output.provenance.agentDir === "string", "provenance.agentDir must be set");
	assert.ok(typeof output.provenance.sessionsDir === "string", "provenance.sessionsDir must be set");

	assert.equal(output.sessions.length, 1);
	const session = output.sessions[0];
	assert.ok(typeof session.filePath === "string", "filePath must be present with --include-paths");
	assert.equal(session.projectLabel, "my-project-slug", "projectLabel must be the cwd slug");
});

test("tlh-sessions: --include-paths adds provenance to per-tool output", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);
	writeSessionFile(sessionsDir, "slug", "session.jsonl", [
		sessionHeaderLine(),
		assistantLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-1", toolName: "read" }]),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-1", { toolName: "read" }),
	]);

	const result = runSessions(agentDir, ["--mode", "per-tool", "--include-paths"]);
	const output = parseJsonOutput(result);

	assert.ok(typeof output.provenance.agentDir === "string");
	assert.ok(typeof output.provenance.sessionsDir === "string");
});

// ---------------------------------------------------------------------------
// Fix 7: --include-content flag is removed; it must now be rejected
// ---------------------------------------------------------------------------

test("tlh-sessions: --include-content is no longer accepted and exits non-zero", (t) => {
	const { agentDir } = makeAgentFixture(t);
	const result = runSessions(agentDir, ["--include-content"]);
	assert.notEqual(result.status, 0, "--include-content must exit non-zero after removal");
});

// ---------------------------------------------------------------------------
// Tests: session enumeration
// ---------------------------------------------------------------------------

test("tlh-sessions: enumerates multiple sessions across different slugs", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);
	writeSessionFile(sessionsDir, "project-a", "session.jsonl", [
		sessionHeaderLine("sess-a", "/workspace/project-a"),
		assistantLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-1", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-1"),
	]);
	writeSessionFile(sessionsDir, "project-b", "session.jsonl", [
		sessionHeaderLine("sess-b", "/workspace/project-b"),
		assistantLine("2026-01-01T00:01:00.000Z", [{ toolCallId: "tc-2", toolName: "read" }]),
		toolResultLine("2026-01-01T00:01:01.000Z", "tc-2", { toolName: "read" }),
	]);

	const result = runSessions(agentDir);
	const output = parseJsonOutput(result);

	assert.equal(output.coverage.filesScanned, 2);
	assert.equal(output.sessions.length, 2);
});

test("tlh-sessions: enumerates child session files nested deeper than one level", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);

	// Top-level session
	writeSessionFile(sessionsDir, "project-a", "session.jsonl", [
		sessionHeaderLine("sess-parent"),
	]);

	// Child session nested under <cwd-slug>/<parent-session-stem>/<runId>/run-N/session.jsonl
	const childDir = join(sessionsDir, "project-a", "sess-parent", "run-001", "run-1");
	mkdirSync(childDir, { recursive: true });
	writeFileSync(
		join(childDir, "session.jsonl"),
		sessionHeaderLine("sess-child") + "\n",
		"utf8",
	);

	const result = runSessions(agentDir);
	const output = parseJsonOutput(result);

	assert.equal(output.coverage.filesScanned, 2, "must scan both parent and child session");
});

test("tlh-sessions: never reads run-history.jsonl", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);

	// Place a run-history.jsonl that contains invalid JSON — if read it will cause errors
	const slug = "project-x";
	const slugDir = join(sessionsDir, slug);
	mkdirSync(slugDir, { recursive: true });
	writeFileSync(join(slugDir, "run-history.jsonl"), "INVALID_SHOULD_NOT_BE_READ\n", "utf8");

	// Also write a valid session file
	writeSessionFile(sessionsDir, slug, "session.jsonl", [
		sessionHeaderLine("sess-ok"),
	]);

	const result = runSessions(agentDir);
	// Must succeed (exit 0) and not report any malformed lines from run-history.jsonl
	assert.equal(result.status, 0, `stderr: ${result.stderr}`);
	const output = parseJsonOutput(result);
	assert.equal(output.coverage.totalMalformedLines, 0);
	assert.equal(output.sessions.length, 1, "only the valid session.jsonl must be scanned");
});

// ---------------------------------------------------------------------------
// Tests: coverage and statistics
// ---------------------------------------------------------------------------

test("tlh-sessions: coverage reflects scanned files", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);
	writeSessionFile(sessionsDir, "slug", "session.jsonl", [
		sessionHeaderLine(),
		assistantLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-1", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-1"),
	]);

	const result = runSessions(agentDir);
	const output = parseJsonOutput(result);

	assert.equal(output.coverage.filesScanned, 1);
	assert.equal(output.coverage.totalMalformedLines, 0);
	assert.equal(output.coverage.totalUnmatchedToolCalls, 0);
	assert.equal(output.coverage.totalUnmatchedToolResults, 0);
});

// Fix 5: coverage reports filesDiscovered, failedScans, unreadableDirectories
test("tlh-sessions: coverage reports filesDiscovered and failedScans fields", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);
	writeSessionFile(sessionsDir, "slug", "session.jsonl", [
		sessionHeaderLine(),
	]);

	const result = runSessions(agentDir);
	const output = parseJsonOutput(result);

	assert.ok("filesDiscovered" in output.coverage, "filesDiscovered must be in coverage");
	assert.ok("failedScans" in output.coverage, "failedScans must be in coverage");
	assert.ok("unreadableDirectories" in output.coverage, "unreadableDirectories must be in coverage");
	assert.equal(output.coverage.filesDiscovered, 1);
	assert.equal(output.coverage.failedScans, 0);
	assert.equal(output.coverage.unreadableDirectories, 0);
});

test("tlh-sessions: per-session latency stats are computed correctly", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);
	// Two tool pairs: 1000ms and 3000ms
	writeSessionFile(sessionsDir, "slug", "session.jsonl", [
		sessionHeaderLine(),
		assistantLine("2026-01-01T00:00:00.000Z", [
			{ toolCallId: "tc-1", toolName: "bash" },
			{ toolCallId: "tc-2", toolName: "bash" },
		]),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-1"),
		toolResultLine("2026-01-01T00:00:03.000Z", "tc-2"),
	]);

	const result = runSessions(agentDir);
	const output = parseJsonOutput(result);

	const session = output.sessions[0];
	// Fix 4: toolCallCount should be the observed count (2 calls, both matched)
	assert.equal(session.toolCallCount, 2);
	assert.equal(session.observedLatencyMs.min, 1000);
	assert.equal(session.observedLatencyMs.max, 3000);
	assert.equal(session.observedLatencyMs.median, 2000);
});

// Fix 4: toolCallCount must reflect all observed calls, not just matched pairs
test("tlh-sessions: toolCallCount uses observedToolCallCount even for unmatched calls", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);
	// 3 calls emitted, only 1 result — simulates a truncated session
	writeSessionFile(sessionsDir, "slug", "session.jsonl", [
		sessionHeaderLine(),
		assistantLine("2026-01-01T00:00:00.000Z", [
			{ toolCallId: "tc-1", toolName: "bash" },
			{ toolCallId: "tc-2", toolName: "bash" },
			{ toolCallId: "tc-3", toolName: "bash" },
		]),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-1"),
	]);

	const result = runSessions(agentDir);
	const output = parseJsonOutput(result);

	const session = output.sessions[0];
	assert.equal(session.toolCallCount, 3, "must report all 3 observed calls, not just the 1 matched pair");
	assert.equal(session.unmatchedToolCalls, 2);
});

test("tlh-sessions: per-tool rollup aggregates tool calls across sessions", (t) => {
	const { agentDir, sessionsDir } = makeAgentFixture(t);
	writeSessionFile(sessionsDir, "proj-a", "session.jsonl", [
		sessionHeaderLine("sess-a"),
		assistantLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-1", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:01.000Z", "tc-1"),
	]);
	writeSessionFile(sessionsDir, "proj-b", "session.jsonl", [
		sessionHeaderLine("sess-b"),
		assistantLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-2", toolName: "bash" }]),
		toolResultLine("2026-01-01T00:00:02.000Z", "tc-2"),
	]);

	const result = runSessions(agentDir, ["--mode", "per-tool"]);
	const output = parseJsonOutput(result);

	const bashTool = output.tools.find((t) => t.toolName === "bash");
	assert.ok(bashTool, "bash tool must appear in per-tool output");
	assert.equal(bashTool.callCount, 2, "callCount must aggregate across sessions");
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

// Fix 3: usage string must say "node scripts/tlh-sessions.mjs", not "tlh sessions"
test("tlh-sessions: --help prints usage with correct invocation and exits 0", (t) => {
	const { agentDir } = makeAgentFixture(t);
	const result = runSessions(agentDir, ["--help"]);
	assert.equal(result.status, 0);
	assert.ok(result.stdout.includes("node scripts/tlh-sessions.mjs"), "usage must show correct node invocation");
	assert.ok(result.stdout.includes("per-session"), "usage must mention per-session");
	assert.ok(result.stdout.includes("per-tool"), "usage must mention per-tool");
	// Fix 7: --include-content must not be advertised
	assert.ok(!result.stdout.includes("--include-content"), "--include-content must not appear in help text");
});

test("tlh-sessions: unknown --mode value exits non-zero", (t) => {
	const { agentDir } = makeAgentFixture(t);
	const result = runSessions(agentDir, ["--mode", "invalid-mode"]);
	assert.notEqual(result.status, 0);
});

test("tlh-sessions: unknown flag exits non-zero", (t) => {
	const { agentDir } = makeAgentFixture(t);
	const result = runSessions(agentDir, ["--unknown-flag"]);
	assert.notEqual(result.status, 0);
});

test("tlh-sessions: missing sessions directory is tolerated (returns empty result)", (t) => {
	const root = makeTempDir("tlh-sessions-empty-", t);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	// No sessions/ subdirectory

	const result = runSessions(agentDir);
	const output = parseJsonOutput(result);
	assert.equal(output.coverage.filesScanned, 0);
	assert.equal(output.sessions.length, 0);
});

// ---------------------------------------------------------------------------
// Tests: provenance correctness
// ---------------------------------------------------------------------------

// Fix 8: profileSource must reflect the actual resolution source
test("tlh-sessions: profileSource is 'flag' when --agent-dir is passed", (t) => {
	const { agentDir } = makeAgentFixture(t);

	for (const extraArgs of [[], ["--mode", "per-tool"]]) {
		const result = runSessions(agentDir, extraArgs);
		const output = parseJsonOutput(result);
		assert.equal(
			output.provenance.profileSource,
			"flag",
			"profileSource must be 'flag' when --agent-dir is explicitly passed",
		);
	}
});

test("tlh-sessions: default provenance contains required non-identifying fields in both modes", (t) => {
	const { agentDir } = makeAgentFixture(t);

	for (const extraArgs of [[], ["--mode", "per-tool"]]) {
		const result = runSessions(agentDir, extraArgs);
		const output = parseJsonOutput(result);
		const prov = output.provenance;

		assert.equal(prov.toolName, "tlh-sessions", "toolName must be set in default mode");
		// Fix 8: valid sources now include "flag" (tests always pass --agent-dir)
		const validSources = ["flag", "PI_CODING_AGENT_DIR", "TLH_AGENT_DIR", "default"];
		assert.ok(
			validSources.includes(prov.profileSource),
			`profileSource must be a known value; got: ${prov.profileSource}`,
		);
		assert.ok(
			typeof prov.profileId === "string" && /^[0-9a-f]{12}$/.test(prov.profileId),
			"profileId must be 12 lowercase hex chars",
		);
	}
});

test("tlh-sessions: default provenance contains no path or username substrings", (t) => {
	const { agentDir } = makeAgentFixture(t);

	// Run both modes without --include-paths
	for (const extraArgs of [[], ["--mode", "per-tool"]]) {
		const result = runSessions(agentDir, extraArgs);
		const output = parseJsonOutput(result);
		const provenanceJson = JSON.stringify(output.provenance);

		// agentDir contains the temp dir path — must not leak
		const agentDirResolved = resolve(agentDir);
		assert.ok(
			!provenanceJson.includes(agentDirResolved),
			`provenance must not contain the resolved agentDir path: ${agentDirResolved}`,
		);
		// profileId must be hex only — no slashes or path separators
		assert.ok(
			!/[\/\\]/.test(output.provenance.profileId),
			"profileId must not contain path separators",
		);
	}
});

test("tlh-sessions: agentDir and sessionsDir appear in provenance only with --include-paths", (t) => {
	const { agentDir } = makeAgentFixture(t);

	// Without --include-paths: path fields absent
	const defaultResult = runSessions(agentDir);
	const defaultOutput = parseJsonOutput(defaultResult);
	assert.ok(!("agentDir" in defaultOutput.provenance), "agentDir must not appear without --include-paths");
	assert.ok(!("sessionsDir" in defaultOutput.provenance), "sessionsDir must not appear without --include-paths");

	// With --include-paths: path fields present
	const pathsResult = runSessions(agentDir, ["--include-paths"]);
	const pathsOutput = parseJsonOutput(pathsResult);
	assert.ok(typeof pathsOutput.provenance.agentDir === "string", "agentDir must appear with --include-paths");
	assert.ok(typeof pathsOutput.provenance.sessionsDir === "string", "sessionsDir must appear with --include-paths");

	// Same check for per-tool mode
	const perToolDefault = runSessions(agentDir, ["--mode", "per-tool"]);
	const perToolDefaultOutput = parseJsonOutput(perToolDefault);
	assert.ok(!("agentDir" in perToolDefaultOutput.provenance));

	const perToolPaths = runSessions(agentDir, ["--mode", "per-tool", "--include-paths"]);
	const perToolPathsOutput = parseJsonOutput(perToolPaths);
	assert.ok(typeof perToolPathsOutput.provenance.agentDir === "string");
});

test("tlh-sessions: profileId is stable across two runs from the same agentDir", (t) => {
	const { agentDir } = makeAgentFixture(t);

	const run1 = parseJsonOutput(runSessions(agentDir));
	const run2 = parseJsonOutput(runSessions(agentDir));

	assert.equal(
		run1.provenance.profileId,
		run2.provenance.profileId,
		"profileId must be identical across runs from the same agentDir",
	);
});

test("tlh-sessions: profileId differs for different agentDirs", (t) => {
	const fixture1 = makeAgentFixture(t, "tlh-sessions-profid-a-");
	const fixture2 = makeAgentFixture(t, "tlh-sessions-profid-b-");

	const out1 = parseJsonOutput(runSessions(fixture1.agentDir));
	const out2 = parseJsonOutput(runSessions(fixture2.agentDir));

	assert.notEqual(
		out1.provenance.profileId,
		out2.provenance.profileId,
		"profileId must differ for distinct agentDirs",
	);
});
