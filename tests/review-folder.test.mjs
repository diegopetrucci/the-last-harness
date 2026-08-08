import {
	assert,
	assertNoStandaloneLine,
	assertRenderedPathLine,
	chmodSync,
	createReviewHarness,
	join,
	makeTempDir,
	mkdirSync,
	test,
	writeFileSync,
} from "./review-test-helpers.mjs";

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
	assertRenderedPathLine(harness.sentMessages[0], /^\[skipped binary detection failure: (".*")\]$/, "docs/secret.txt");
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
