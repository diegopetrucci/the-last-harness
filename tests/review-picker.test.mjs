import {
	assert,
	createReviewHarness,
	join,
	makePrimaryFixture,
	makeTempDir,
	mkdirSync,
	test,
	withEnv,
	writeFileSync,
} from "./review-test-helpers.mjs";

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
		'uncommitted --extra "focus on error handling"',
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
		branchEntries: [{ type: "custom", customType: "tlh-primary-agent-state", data: { selected: "architect" } }],
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
			message:
				"base cannot start with '-' (got '-feature/parent'). If this is intentional, run the underlying command manually.",
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
			message:
				"sha cannot start with '-' (got '-abc123'). If this is intentional, run the underlying command manually.",
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
				args.join(" ") === "pr view 123 --json number,headRefName,baseRefName,isCrossRepository,headRepository"
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
