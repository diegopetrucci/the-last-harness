import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	buildReviewEnvelope,
	decideBranchAction,
	parseReviewArgs,
	registerReviewCommand,
} from "../extensions/the-last-harness/review.ts";
import { cleanupTempDir, createIsolatedProfileFixture, makeTempDir as makeSharedTempDir, withEnv } from "./test-fixture-helpers.mjs";

const reviewEnvRoot = makeSharedTempDir("tlh-review-agent-env-");
const reviewEnvHome = join(reviewEnvRoot, "home");
const reviewEnvAgent = join(reviewEnvRoot, "agent");
const previousReviewPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousReviewHome = process.env.HOME;
mkdirSync(reviewEnvHome, { recursive: true });
mkdirSync(reviewEnvAgent, { recursive: true });
process.env.PI_CODING_AGENT_DIR = reviewEnvAgent;
process.env.HOME = reviewEnvHome;
process.on("exit", () => {
	cleanupTempDir(reviewEnvRoot);
	if (previousReviewPiAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousReviewPiAgentDir;
	}
	if (previousReviewHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = previousReviewHome;
	}
});

/**
 * @param {{
 * 	cwd: string;
 * 	exec: (command: string, args: string[], options: { cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;
 * 	hasUI?: boolean;
 * 	custom?: () => Promise<unknown> | unknown;
 * 	editor?: (title: string, prefill?: string) => Promise<string | undefined> | string | undefined;
 * 	branchEntries?: unknown[];
 * }} params
 */
function createReviewHarness({ cwd, exec, hasUI = true, custom, editor, branchEntries = [] }) {
	let handler;
	/** @type {Array<{ command: string; args: string[]; cwd?: string }>} */
	const execCalls = [];
	/** @type {Array<{ message: string; level: string }>} */
	const notifications = [];
	/** @type {string[]} */
	const sentMessages = [];
	/** @type {Array<{ title: string; prefill?: string }>} */
	const editorCalls = [];
	let customCallCount = 0;

	registerReviewCommand({
		registerCommand(name, command) {
			if (name === "review") {
				handler = command.handler;
			}
		},
		exec: async (command, args, options) => {
			execCalls.push({ command, args, cwd: options?.cwd });
			return exec(command, args, options ?? {});
		},
		sendUserMessage(message) {
			sentMessages.push(message);
		},
	});

	assert.equal(typeof handler, "function", "review command should register a handler");

	return {
		handler,
		execCalls,
		notifications,
		sentMessages,
		editorCalls,
		get customCallCount() {
			return customCallCount;
		},
		ctx: {
			cwd,
			hasUI,
			sessionManager: {
				getBranch: () => branchEntries,
			},
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
				custom: async () => {
					customCallCount += 1;
					return custom ? custom() : true;
				},
				editor: async (title, prefill) => {
					editorCalls.push({ title, prefill });
					return editor ? editor(title, prefill) : undefined;
				},
			},
		},
	};
}

function makeTempDir(t, prefix) {
	return makeSharedTempDir(prefix, t);
}

function makePrimaryFixture(t, prefix) {
	return createIsolatedProfileFixture(prefix, { cwd: true, test: t });
}

function assertRenderedPathLine(message, linePattern, expectedPath) {
	const line = message.split("\n").find((candidate) => linePattern.test(candidate));
	assert.ok(line, `expected a line matching ${linePattern}`);

	const match = line.match(linePattern);
	assert.ok(match, `expected a line matching ${linePattern}`);
	assert.equal(JSON.parse(match[1]), expectedPath);
}

function assertNoStandaloneLine(message, unexpectedLine) {
	assert.equal(
		message.split("\n").includes(unexpectedLine),
		false,
		`should not render '${unexpectedLine}' as a standalone line`,
	);
}

function assertStandaloneLineCount(message, expectedLine, expectedCount) {
	assert.equal(
		message.split("\n").filter((line) => line === expectedLine).length,
		expectedCount,
		`expected ${expectedCount} standalone '${expectedLine}' line(s)`,
	);
}

// ─── (a) parseReviewArgs ───────────────────────────────────────────────────────

test("parseReviewArgs: empty argv requests the picker", () => {
	assert.deepEqual(parseReviewArgs([]), { pickerRequested: true });
});

test("parseReviewArgs: typed review args are rejected with picker-only guidance", () => {
	for (const argv of [
		["uncommitted"],
		["branch", "feature/parent"],
		["commit", "abc123"],
		["pr", "42"],
		["folder", "src"],
		["uncommitted", "--extra", "focus on perf"],
	]) {
		assert.deepEqual(parseReviewArgs(argv), {
			pickerRequested: false,
			message:
				"/review is picker-only. Run /review with no arguments, then choose a mode in the picker. Typed shortcuts like `/review pr 123` and `--extra` are no longer supported.",
		});
	}
});

// ─── (b) buildReviewEnvelope ───────────────────────────────────────────────────

test("buildReviewEnvelope: first line is exactly [/review]", () => {
	const envelope = buildReviewEnvelope({ mode: "uncommitted", extra: undefined });
	const firstLine = envelope.split("\n")[0];
	assert.equal(firstLine, "[/review]");
});

test("buildReviewEnvelope: branch+base with currentBranch ctx and no body contains expected metadata and pending fence", () => {
	const envelope = buildReviewEnvelope(
		{ mode: "branch", base: "main", extra: undefined },
		{ currentBranch: "feature/x" },
	);
	const lines = envelope.split("\n");

	assert.ok(lines.includes("mode: branch"), "contains mode: branch");
	assert.ok(lines.includes("base: main"), "contains base: main");
	assert.ok(lines.includes("current-branch: feature/x"), "contains current-branch: feature/x");
	assert.ok(lines.includes("extra: (none)"), "contains extra: (none) when extra is undefined");
	assert.ok(lines.includes("--- begin (pending) ---"), "contains begin pending fence");
	assert.ok(lines.includes("--- end (pending) ---"), "contains end pending fence");
});

test("buildReviewEnvelope: diff body is included verbatim inside diff fence", () => {
	const body = "DIFF\nBODY";
	const envelope = buildReviewEnvelope(
		{ mode: "uncommitted", extra: undefined },
		{ body, bodyKind: "diff" },
	);
	assert.ok(envelope.includes("--- begin diff ---"), "contains begin diff fence");
	assert.ok(envelope.includes("--- end diff ---"), "contains end diff fence");
	assert.ok(envelope.includes(body), "body is present verbatim");
	// Ensure body appears between the fences
	const beginIdx = envelope.indexOf("--- begin diff ---");
	const endIdx = envelope.indexOf("--- end diff ---");
	const bodyIdx = envelope.indexOf(body);
	assert.ok(beginIdx < bodyIdx && bodyIdx < endIdx, "body is between fence markers");
});

test("buildReviewEnvelope: snapshot body uses snapshot fence", () => {
	const envelope = buildReviewEnvelope(
		{ mode: "folder", paths: ["src"], extra: undefined },
		{ body: "SNAP", bodyKind: "snapshot" },
	);
	assert.ok(envelope.includes("--- begin snapshot ---"), "contains begin snapshot fence");
	assert.ok(envelope.includes("--- end snapshot ---"), "contains end snapshot fence");
	assert.ok(envelope.includes("SNAP"), "snapshot body is present");
});

test("buildReviewEnvelope: exact diff fence lines inside the body are escaped", () => {
	const envelope = buildReviewEnvelope(
		{ mode: "uncommitted", extra: undefined },
		{ body: "before\n--- end diff ---\nafter", bodyKind: "diff" },
	);
	assert.match(envelope, /\\--- end diff ---/);
});

test("buildReviewEnvelope: checkout ctx produces switched-from line", () => {
	const envelope = buildReviewEnvelope(
		{ mode: "pr", nOrUrl: "42", extra: undefined },
		{ checkout: { performed: true, priorBranch: "main" } },
	);
	const lines = envelope.split("\n");
	assert.ok(lines.includes("checkout: switched-from main"), "contains checkout: switched-from main");
});

test("buildReviewEnvelope: extra value appears after extra: label (not the none literal)", () => {
	const envelope = buildReviewEnvelope(
		{ mode: "uncommitted", extra: "watch perf" },
	);
	const lines = envelope.split("\n");
	const extraLabelIdx = lines.indexOf("extra:");
	assert.notEqual(extraLabelIdx, -1, "extra: label line is present");
	assert.equal(lines[extraLabelIdx + 1], "watch perf", "extra value is on the next line");
	assert.ok(!envelope.includes("extra: (none)"), "does not contain the none literal");
});

test("buildReviewEnvelope: multi-line extra is preserved verbatim", () => {
	const multiLineExtra = "line one\nline two\nline three";
	const envelope = buildReviewEnvelope(
		{ mode: "uncommitted", extra: multiLineExtra },
	);
	assert.ok(envelope.includes(multiLineExtra), "multi-line extra is preserved verbatim");
});

// ─── (c) decideBranchAction ────────────────────────────────────────────────────

// Regression: ensure the pure helper still produces all four expected outcomes
// after the gather-layer changes introduced by the review-fixes pass.
test("decideBranchAction regression: all four outcomes are stable", () => {
	// Same branch → always proceed regardless of dirty/confirm
	assert.equal(
		decideBranchAction({ currentBranch: "feat", prHead: "feat", isDirty: true, userConfirm: false }),
		"proceed",
	);
	// Mismatched + dirty → abort-dirty regardless of confirm
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feat", isDirty: true, userConfirm: true }),
		"abort-dirty",
	);
	// Mismatched + clean + confirmed → switch
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feat", isDirty: false, userConfirm: true }),
		"switch",
	);
	// Mismatched + clean + not confirmed → abort-cancelled
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feat", isDirty: false, userConfirm: false }),
		"abort-cancelled",
	);
});

test("decideBranchAction: on-head branch returns proceed", () => {
	assert.equal(
		decideBranchAction({ currentBranch: "feature/x", prHead: "feature/x", isDirty: false, userConfirm: false }),
		"proceed",
	);
});

test("decideBranchAction: mismatched branch with dirty tree returns abort-dirty", () => {
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feature/x", isDirty: true, userConfirm: false }),
		"abort-dirty",
	);
});

test("decideBranchAction: clean mismatch with user confirmation returns switch", () => {
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feature/x", isDirty: false, userConfirm: true }),
		"switch",
	);
});

test("decideBranchAction: clean mismatch with no confirmation returns abort-cancelled", () => {
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feature/x", isDirty: false, userConfirm: false }),
		"abort-cancelled",
	);
});

// ─── (d) command gather regressions ───────────────────────────────────────────

test("/review rejects typed shortcuts and does not open the picker", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-typed-shortcuts-");

	const harness = createReviewHarness({
		cwd,
		custom: () => {
			throw new Error("picker should not open when typed args are provided");
		},
		exec: async (command, args) => {
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	for (const input of [
		"uncommitted",
		"branch feature/parent",
		"commit abc123",
		"pr 123",
		"folder src",
		"uncommitted --extra \"focus on error handling\"",
	]) {
		await harness.handler(input, harness.ctx);
	}

	assert.equal(harness.customCallCount, 0);
	assert.equal(harness.execCalls.length, 0);
	assert.equal(harness.sentMessages.length, 0);
	assert.deepEqual(
		harness.notifications,
		Array.from({ length: 6 }, () => ({
			message:
				"/review is picker-only. Run /review with no arguments, then choose a mode in the picker. Typed shortcuts like `/review pr 123` and `--extra` are no longer supported.",
			level: "error",
		})),
	);
});

test("/review without TUI fails clearly because the picker is required", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-no-tui-");

	const harness = createReviewHarness({
		cwd,
		hasUI: false,
		exec: async (command, args) => {
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 0);
	assert.equal(harness.execCalls.length, 0);
	assert.equal(harness.sentMessages.length, 0);
	assert.deepEqual(harness.notifications, [
		{
			message: "/review requires the interactive TUI picker. Re-run /review in the TLH UI.",
			level: "error",
		},
	]);
});


test("/review still opens the picker when the architect primary agent is active", async (t) => {
	const fixture = makePrimaryFixture(t, "tlh-review-architect-primary-");
	const harness = createReviewHarness({
		cwd: fixture.cwd,
		branchEntries: [
			{ type: "custom", customType: "tlh-primary-agent-state", data: { selected: "architect" } },
		],
		custom: () => undefined,
		exec: async (command, args) => {
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		await harness.handler("", harness.ctx);
	});

	assert.equal(harness.customCallCount, 1);
	assert.equal(harness.execCalls.length, 0);
	assert.equal(harness.sentMessages.length, 0);
	assert.deepEqual(harness.notifications, []);
});


test("/review blocks non-architect primary mode before opening the picker or gathering diffs", async (t) => {
	const fixture = makePrimaryFixture(t, "tlh-review-rush-primary-");
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { primaryAgent: { enabled: true, selected: "rush" } } }, null, 2)}\n`,
	);

	const harness = createReviewHarness({
		cwd: fixture.cwd,
		custom: () => {
			throw new Error("picker should not open outside architect mode");
		},
		exec: async (command, args) => {
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		await harness.handler("", harness.ctx);
	});

	assert.equal(harness.customCallCount, 0);
	assert.equal(harness.execCalls.length, 0);
	assert.equal(harness.sentMessages.length, 0);
	assert.deepEqual(harness.notifications, [
		{
			message:
				"/review only works while the architect primary agent is active. Current primary agent: rush. Switch to architect with /switch-primary-agent architect (or Shift+Tab), then rerun /review.",
			level: "error",
		},
	]);
});

test("/review picker-selected branch prompts for a base and defaults blank input to main", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-picker-branch-");

	const harness = createReviewHarness({
		cwd,
		custom: () => "branch",
		editor: () => "   ",
		exec: async (command, args) => {
			if (command === "git" && args.join(" ") === "symbolic-ref -q HEAD") {
				return { code: 0, stdout: "refs/heads/feature/review\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "feature/review\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --verify main") {
				return { code: 0, stdout: "abc123\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "diff main...HEAD") {
				return { code: 0, stdout: "diff --git a/src/app.ts b/src/app.ts\n", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 1);
	assert.deepEqual(harness.editorCalls, [
		{
			title: "Review branch: enter base branch (blank defaults to main)",
			prefill: "main",
		},
	]);
	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /base: main/);
});

test("/review picker-selected branch uses a non-empty prompted base", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-picker-branch-custom-base-");

	const harness = createReviewHarness({
		cwd,
		custom: () => "branch",
		editor: () => "feature/parent",
		exec: async (command, args) => {
			if (command === "git" && args.join(" ") === "symbolic-ref -q HEAD") {
				return { code: 0, stdout: "refs/heads/feature/review\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "feature/review\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --verify feature/parent") {
				return { code: 0, stdout: "def456\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "diff feature/parent...HEAD") {
				return { code: 0, stdout: "diff --git a/src/app.ts b/src/app.ts\n", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 1);
	assert.deepEqual(harness.editorCalls, [
		{
			title: "Review branch: enter base branch (blank defaults to main)",
			prefill: "main",
		},
	]);
	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /base: feature\/parent/);
});

test("/review picker-selected branch cancellation aborts without dispatch", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-picker-branch-cancel-");

	const harness = createReviewHarness({
		cwd,
		custom: () => "branch",
		editor: () => undefined,
		exec: async (command, args) => {
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 1);
	assert.deepEqual(harness.editorCalls, [
		{
			title: "Review branch: enter base branch (blank defaults to main)",
			prefill: "main",
		},
	]);
	assert.equal(harness.execCalls.length, 0);
	assert.equal(harness.sentMessages.length, 0);
	assert.equal(harness.notifications.length, 0);
});

test("/review picker-selected branch rejects a leading-dash base before git use", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-branch-leading-dash-");

	const harness = createReviewHarness({
		cwd,
		custom: () => "branch",
		editor: () => "-feature/parent",
		exec: async (command, args) => {
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 1);
	assert.deepEqual(harness.editorCalls, [
		{
			title: "Review branch: enter base branch (blank defaults to main)",
			prefill: "main",
		},
	]);
	assert.equal(harness.execCalls.length, 0);
	assert.equal(harness.sentMessages.length, 0);
	assert.deepEqual(harness.notifications, [
		{
			message: "base cannot start with '-' (got '-feature/parent'). If this is intentional, run the underlying command manually.",
			level: "error",
		},
	]);
});

test("/review picker-selected commit rejects a leading-dash sha before git use", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-commit-leading-dash-");

	const harness = createReviewHarness({
		cwd,
		custom: () => "commit",
		editor: () => "-abc123",
		exec: async (command, args) => {
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 1);
	assert.equal(harness.execCalls.length, 0);
	assert.equal(harness.sentMessages.length, 0);
	assert.deepEqual(harness.notifications, [
		{
			message: "sha cannot start with '-' (got '-abc123'). If this is intentional, run the underlying command manually.",
			level: "error",
		},
	]);
});


test("/review picker-selected pr rejects a leading-dash ref before gh use", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-pr-leading-dash-");

	const harness = createReviewHarness({
		cwd,
		custom: () => "pr",
		editor: () => "-42",
		exec: async (command, args) => {
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 1);
	assert.equal(harness.execCalls.length, 0);
	assert.equal(harness.sentMessages.length, 0);
	assert.deepEqual(harness.notifications, [
		{
			message: "pr cannot start with '-' (got '-42'). If this is intentional, run the underlying command manually.",
			level: "error",
		},
	]);
});

test("/review picker-selected commit prompts for a sha before dispatch", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-picker-commit-");

	const harness = createReviewHarness({
		cwd,
		custom: () => "commit",
		editor: () => "abc123",
		exec: async (command, args) => {
			if (command === "git" && args.join(" ") === "rev-parse --verify abc123^{commit}") {
				return { code: 0, stdout: "abc123\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "show --format=fuller abc123") {
				return { code: 0, stdout: "commit abc123\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "feature/review\n", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 1);
	assert.deepEqual(harness.editorCalls, [{ title: "Review commit: enter commit SHA", prefill: undefined }]);
	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /mode: commit/);
	assert.match(harness.sentMessages[0], /sha: abc123/);
});

test("/review picker-selected pr prompts for a PR number before dispatch", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-picker-pr-");

	const harness = createReviewHarness({
		cwd,
		custom: () => "pr",
		editor: () => "123",
		exec: async (command, args) => {
			if (command === "gh" && args.join(" ") === "--version") {
				return { code: 0, stdout: "gh version 2.0.0\n", stderr: "" };
			}
			if (
				command === "gh" &&
				args.join(" ") ===
					"pr view 123 --json number,headRefName,baseRefName,isCrossRepository,headRepository"
			) {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 123,
						headRefName: "feature/review",
						baseRefName: "main",
						isCrossRepository: false,
					}),
					stderr: "",
				};
			}
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "feature/review\n", stderr: "" };
			}
			if (command === "gh" && args.join(" ") === "pr diff 123") {
				return { code: 0, stdout: "diff --git a/src/app.ts b/src/app.ts\n", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 1);
	assert.deepEqual(harness.editorCalls, [{ title: "Review PR: enter PR number or URL", prefill: undefined }]);
	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /mode: pr/);
	assert.match(harness.sentMessages[0], /pr: 123/);
});

test("/review picker-selected folder prompts for paths before dispatch", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-picker-folder-");
	mkdirSync(join(cwd, "src"), { recursive: true });
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "src", "app.ts"), "export const app = true;\n");
	writeFileSync(join(cwd, "docs", "guide.md"), "# Guide\n");

	const harness = createReviewHarness({
		cwd,
		custom: () => "folder",
		editor: () => "src\ndocs",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
			}
			if (
				command === "git" &&
				args.join(" ") === "ls-files -z --cached --others --exclude-standard -- ." &&
				(options.cwd === join(cwd, "src") || options.cwd === join(cwd, "docs"))
			) {
				return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 1);
	assert.deepEqual(harness.editorCalls, [
		{ title: "Review folder: enter one or more paths (quote paths with spaces)", prefill: undefined },
	]);
	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /paths: src docs/);
	assert.match(harness.sentMessages[0], /--- file: "src\/app\.ts" ---\nexport const app = true;/);
	assert.match(harness.sentMessages[0], /--- file: "docs\/guide\.md" ---\n# Guide/);
});

test("/review picker follow-up cancellation does not dispatch incomplete args", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-picker-cancel-");

	const harness = createReviewHarness({
		cwd,
		custom: () => "commit",
		editor: () => "   ",
		exec: async (command, args) => {
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.customCallCount, 1);
	assert.deepEqual(harness.editorCalls, [{ title: "Review commit: enter commit SHA", prefill: undefined }]);
	assert.equal(harness.execCalls.length, 0);
	assert.equal(harness.sentMessages.length, 0);
	assert.equal(harness.notifications.length, 0);
});

test("/review uncommitted appends untracked non-gitignored file content", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-uncommitted-");
	writeFileSync(join(cwd, "new-file.ts"), "export const fresh = true;\n");

	const harness = createReviewHarness({
		cwd,
		custom: () => "uncommitted",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "feature/untracked\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "diff HEAD") {
				return { code: 0, stdout: "diff --git a/app.ts b/app.ts\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel" && options.cwd === cwd) {
				return { code: 0, stdout: `${cwd}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "ls-files -z --others --exclude-standard -- ." && options.cwd === cwd) {
				return { code: 0, stdout: "new-file.ts\0", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.notifications.length, 0);
	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /diff --git a\/app.ts b\/app.ts/);
	assert.match(harness.sentMessages[0], /--- begin untracked files ---/);
	assert.match(harness.sentMessages[0], /--- untracked file: "new-file\.ts" ---\nexport const fresh = true;/);
	assert.ok(
		harness.sentMessages[0].indexOf("diff --git a/app.ts b/app.ts") <
			harness.sentMessages[0].indexOf("--- untracked file: \"new-file.ts\" ---"),
		"untracked content should be appended after the diff body",
	);
});

test("/review uncommitted scans untracked files from the repo root when invoked from a subdirectory", async (t) => {
	const repoRoot = makeTempDir(t, "tlh-review-uncommitted-root-");
	const cwd = join(repoRoot, "packages", "app");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(repoRoot, "outside.ts"), "export const outside = true;\n");

	const harness = createReviewHarness({
		cwd,
		custom: () => "uncommitted",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD" && options.cwd === cwd) {
				return { code: 0, stdout: "feature/untracked\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "diff HEAD" && options.cwd === cwd) {
				return { code: 0, stdout: "diff --git a/app.ts b/app.ts\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel" && options.cwd === cwd) {
				return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
			}
			if (
				command === "git" &&
				args.join(" ") === "ls-files -z --others --exclude-standard -- ." &&
				options.cwd === repoRoot
			) {
				return { code: 0, stdout: "outside.ts\0", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /--- untracked file: "outside\.ts" ---\nexport const outside = true;/);
	assert.doesNotMatch(harness.sentMessages[0], /--- untracked file: "\.\.\/outside\.ts" ---/);
	assert.ok(
		harness.execCalls.some(({ command, args, cwd: callCwd }) =>
			command === "git" && args.join(" ") === "rev-parse --show-toplevel" && callCwd === cwd),
		"should resolve the repository root from the invocation cwd",
	);
	assert.ok(
		harness.execCalls.some(({ command, args, cwd: callCwd }) =>
			command === "git" && args.join(" ") === "ls-files -z --others --exclude-standard -- ." && callCwd === repoRoot),
		"should scan untracked files from the repository root",
	);
});

test("/review uncommitted preserves exact git-reported paths with leading or trailing spaces", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-untracked-spaces-");
	writeFileSync(join(cwd, " leading.ts"), "export const leading = true;\n");
	writeFileSync(join(cwd, "trailing .ts"), "export const trailing = true;\n");

	const harness = createReviewHarness({
		cwd,
		custom: () => "uncommitted",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "feature/untracked\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "diff HEAD") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel" && options.cwd === cwd) {
				return { code: 0, stdout: `${cwd}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "ls-files -z --others --exclude-standard -- ." && options.cwd === cwd) {
				return { code: 0, stdout: " leading.ts\0trailing .ts\0", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 1);
	assert.ok(harness.sentMessages[0].includes("--- untracked file: \" leading.ts\" ---"));
	assert.ok(harness.sentMessages[0].includes("--- untracked file: \"trailing .ts\" ---"));
});

test("/review uncommitted renders newline/control/delimiter-like untracked paths as escaped labels", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-untracked-weird-");
	const weirdPath = `line\n\t--- end snapshot ---.ts`;
	writeFileSync(join(cwd, weirdPath), "export const weird = true;\n");

	const harness = createReviewHarness({
		cwd,
		custom: () => "uncommitted",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "feature/untracked\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "diff HEAD") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel" && options.cwd === cwd) {
				return { code: 0, stdout: `${cwd}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "ls-files -z --others --exclude-standard -- ." && options.cwd === cwd) {
				return { code: 0, stdout: `${weirdPath}\0`, stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 1);
	assertRenderedPathLine(harness.sentMessages[0], /^--- untracked file: (".*") ---$/, weirdPath);
	assertNoStandaloneLine(harness.sentMessages[0], "--- end snapshot ---");
});

test("/review uncommitted skips symlinked untracked files instead of reading targets", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-untracked-symlink-");
	const outsideDir = makeTempDir(t, "tlh-review-untracked-target-");
	const targetPath = join(outsideDir, "secret.txt");
	writeFileSync(targetPath, "outside repo secret\n");
	symlinkSync(targetPath, join(cwd, "outside-link.txt"));

	const harness = createReviewHarness({
		cwd,
		custom: () => "uncommitted",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "feature/untracked\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "diff HEAD") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel" && options.cwd === cwd) {
				return { code: 0, stdout: `${cwd}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "ls-files -z --others --exclude-standard -- ." && options.cwd === cwd) {
				return { code: 0, stdout: "outside-link.txt\0", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 1);
	assertRenderedPathLine(harness.sentMessages[0], /^\[skipped symlink: (".*")\]$/, "outside-link.txt");
	assert.doesNotMatch(harness.sentMessages[0], /outside repo secret/);
});

test("/review uncommitted renders escaped symlink skip markers for newline/delimiter-like paths", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-untracked-symlink-weird-");
	const outsideDir = makeTempDir(t, "tlh-review-untracked-target-weird-");
	const targetPath = join(outsideDir, "secret.txt");
	const weirdLinkPath = `outside]\n\t--- begin untracked files ---.txt`;
	writeFileSync(targetPath, "outside repo secret\n");
	symlinkSync(targetPath, join(cwd, weirdLinkPath));

	const harness = createReviewHarness({
		cwd,
		custom: () => "uncommitted",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "feature/untracked\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "diff HEAD") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel" && options.cwd === cwd) {
				return { code: 0, stdout: `${cwd}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "ls-files -z --others --exclude-standard -- ." && options.cwd === cwd) {
				return { code: 0, stdout: `${weirdLinkPath}\0`, stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 1);
	assertRenderedPathLine(harness.sentMessages[0], /^\[skipped symlink: (".*")\]$/, weirdLinkPath);
	assertStandaloneLineCount(harness.sentMessages[0], "--- begin untracked files ---", 1);
	assert.doesNotMatch(harness.sentMessages[0], /outside repo secret/);
});

test("/review folder keeps empty git ls-files results instead of walking ignored-only directories", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-folder-git-");
	mkdirSync(join(cwd, "ignored-only"), { recursive: true });
	writeFileSync(join(cwd, "ignored-only", "secret.txt"), "should stay ignored\n");

	const harness = createReviewHarness({
		cwd,
		custom: () => "folder",
		editor: () => "ignored-only",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "main\n", stderr: "" };
			}
			if (
				command === "git" &&
				args.join(" ") === "ls-files -z --cached --others --exclude-standard -- ." &&
				options.cwd === join(cwd, "ignored-only")
			) {
				return { code: 0, stdout: "", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.notifications.length, 0);
	assert.equal(harness.sentMessages.length, 1);
	assert.doesNotMatch(harness.sentMessages[0], /secret\.txt/);
	assert.doesNotMatch(harness.sentMessages[0], /should stay ignored/);
	assert.match(harness.sentMessages[0], /--- begin snapshot ---/);
});

test("/review folder still falls back to a plain walk outside git", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-folder-nongit-");
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "guide.md"), "# Guide\n");

	const harness = createReviewHarness({
		cwd,
		custom: () => "folder",
		editor: () => "docs",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
			}
			if (
				command === "git" &&
				args.join(" ") === "ls-files -z --cached --others --exclude-standard -- ." &&
				options.cwd === join(cwd, "docs")
			) {
				return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.notifications.length, 0);
	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /--- file: "docs\/guide\.md" ---\n# Guide/);
});

test("/review folder escapes snapshot fence lines found in file content", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-folder-fence-");
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "guide.md"), "line one\n--- end snapshot ---\nline two\n");

	const harness = createReviewHarness({
		cwd,
		custom: () => "folder",
		editor: () => "docs",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
			}
			if (
				command === "git" &&
				args.join(" ") === "ls-files -z --cached --others --exclude-standard -- ." &&
				options.cwd === join(cwd, "docs")
			) {
				return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /\\--- end snapshot ---/);
	assert.match(harness.sentMessages[0], /\n--- end snapshot ---$/);
});


test("/review folder skips per-file lstat and binary-check failures while continuing", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-folder-problematic-");
	if (process.getuid?.() === 0) {
		t.skip("skipping unreadable-file permission test when running as root");
		return;
	}
	const docsDir = join(cwd, "docs");
	const unreadablePath = join(docsDir, "secret.txt");
	mkdirSync(docsDir, { recursive: true });
	writeFileSync(join(docsDir, "guide.md"), "# Guide\n");
	writeFileSync(unreadablePath, "top secret\n");
	chmodSync(unreadablePath, 0o000);
	t.after(() => {
		try {
			chmodSync(unreadablePath, 0o600);
		} catch {
			// Ignore cleanup failures if the temp directory is already gone.
		}
	});

	const harness = createReviewHarness({
		cwd,
		custom: () => "folder",
		editor: () => "docs",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "main\n", stderr: "" };
			}
			if (
				command === "git" &&
				args.join(" ") === "ls-files -z --cached --others --exclude-standard -- ." &&
				options.cwd === docsDir
			) {
				return { code: 0, stdout: "missing.md\0secret.txt\0guide.md\0", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.notifications.length, 0);
	assert.equal(harness.sentMessages.length, 1);
	assertRenderedPathLine(harness.sentMessages[0], /^\[skipped lstat failure: (".*")\]$/, "docs/missing.md");
	assertRenderedPathLine(
		harness.sentMessages[0],
		/^\[skipped binary detection failure: (".*")\]$/,
		"docs/secret.txt",
	);
	assert.match(harness.sentMessages[0], /--- file: "docs\/guide\.md" ---\n# Guide/);
});

test("/review folder renders newline/control/delimiter-like snapshot paths as escaped labels", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-folder-weird-");
	const weirdName = `tab\t--- begin untracked files ---.md`;
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", weirdName), "# Guide\n");

	const harness = createReviewHarness({
		cwd,
		custom: () => "folder",
		editor: () => "docs",
		exec: async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
			}
			if (
				command === "git" &&
				args.join(" ") === "ls-files -z --cached --others --exclude-standard -- ." &&
				options.cwd === join(cwd, "docs")
			) {
				return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 1);
	assertRenderedPathLine(harness.sentMessages[0], /^--- file: (".*") ---$/, `docs/${weirdName}`);
	assertNoStandaloneLine(harness.sentMessages[0], "--- begin untracked files ---");
});

test("/review pr uses gh pr checkout before diff when switching to the PR head", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-pr-checkout-");
	const customResponses = ["pr", true];

	const harness = createReviewHarness({
		cwd,
		custom: () => customResponses.shift(),
		editor: () => "123",
		exec: async (command, args) => {
			if (command === "gh" && args.join(" ") === "--version") {
				return { code: 0, stdout: "gh version 2.0.0\n", stderr: "" };
			}
			if (
				command === "gh" &&
				args.join(" ") ===
					"pr view 123 --json number,headRefName,baseRefName,isCrossRepository,headRepository"
			) {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 123,
						headRefName: "feature/review",
						baseRefName: "main",
						isCrossRepository: false,
					}),
					stderr: "",
				};
			}
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "main\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "status --porcelain") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "gh" && args.join(" ") === "pr checkout 123") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "gh" && args.join(" ") === "pr diff 123") {
				return { code: 0, stdout: "diff --git a/src/app.ts b/src/app.ts\n", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 1);
	assert.deepEqual(harness.notifications, [
		{
			message: "Switched from 'main' to 'feature/review'. Use `git checkout -` to return.",
			level: "info",
		},
	]);
	assert.ok(
		harness.execCalls.some(({ command, args }) => command === "gh" && args.join(" ") === "pr checkout 123"),
		"should use gh pr checkout for the branch switch",
	);
	assert.equal(
		harness.execCalls.some(({ command, args }) => command === "git" && args[0] === "checkout"),
		false,
	);
	assert.ok(
		harness.execCalls.findIndex(({ command, args }) => command === "gh" && args.join(" ") === "pr checkout 123") <
			harness.execCalls.findIndex(({ command, args }) => command === "gh" && args.join(" ") === "pr diff 123"),
		"should switch branches before gathering the PR diff",
	);
});

test("/review pr aborts before checkout when git status dirty-check fails", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-pr-");
	const customResponses = ["pr"];

	const harness = createReviewHarness({
		cwd,
		custom: () => {
			if (customResponses.length === 0) {
				throw new Error("branch switch confirmation should not be shown when git status fails");
			}
			return customResponses.shift();
		},
		editor: () => "123",
		exec: async (command, args) => {
			if (command === "gh" && args.join(" ") === "--version") {
				return { code: 0, stdout: "gh version 2.0.0\n", stderr: "" };
			}
			if (
				command === "gh" &&
				args.join(" ") ===
					"pr view 123 --json number,headRefName,baseRefName,isCrossRepository,headRepository"
			) {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 123,
						headRefName: "feature/review",
						baseRefName: "main",
						isCrossRepository: false,
					}),
					stderr: "",
				};
			}
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { code: 0, stdout: "main\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "status --porcelain") {
				return { code: 1, stdout: "", stderr: "fatal: index file is corrupt\nmore detail" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 0);
	assert.equal(harness.customCallCount, 1);
	assert.equal(
		harness.execCalls.some(({ command, args }) => command === "git" && args[0] === "checkout"),
		false,
	);
	assert.equal(
		harness.execCalls.some(({ command, args }) => command === "gh" && args.join(" ") === "pr checkout 123"),
		false,
	);
	assert.deepEqual(harness.notifications, [
		{
			message:
				"Could not determine whether the working tree is clean before switching branches: fatal: index file is corrupt",
			level: "error",
		},
	]);
});
