import { assert, createReviewHarness, makeTempDir, test } from "./review-test-helpers.mjs";

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

test("/review pr uses the gh default repo for REST metadata fallback when set", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-pr-rest-view-default-repo-");
	const customResponses = ["pr"];

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
				args.join(" ") === "pr view 123 --json number,headRefName,baseRefName,isCrossRepository,headRepository"
			) {
				return { code: 1, stdout: "", stderr: "GraphQL: API rate limit exceeded" };
			}
			if (command === "gh" && args.join(" ") === "repo set-default --view") {
				return { code: 0, stdout: "acme/selected-repo\n", stderr: "" };
			}
			if (command === "gh" && args.join(" ") === "api repos/acme/selected-repo/pulls/123") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 123,
						head: { ref: "feature/review", repo: { full_name: "acme/selected-repo" } },
						base: { ref: "main", repo: { full_name: "acme/selected-repo" } },
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

	assert.equal(harness.notifications.length, 0);
	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /pr: 123/);
	assert.match(harness.sentMessages[0], /current-branch: feature\/review/);
	assert.match(harness.sentMessages[0], /diff --git a\/src\/app.ts b\/src\/app.ts/);
	assert.ok(
		harness.execCalls.some(
			({ command, args }) => command === "gh" && args.join(" ") === "api repos/acme/selected-repo/pulls/123",
		),
		"should fetch PR metadata via REST using the gh default repository when GraphQL is rate-limited",
	);
	assert.equal(
		harness.execCalls.some(({ command, args }) => command === "git" && args.join(" ") === "remote"),
		false,
		"should not fall back to git remotes when gh already has a default repository",
	);
});

test("/review pr falls back to local remotes for REST metadata when no gh default repo is set", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-pr-rest-view-");
	const customResponses = ["pr"];

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
				args.join(" ") === "pr view 123 --json number,headRefName,baseRefName,isCrossRepository,headRepository"
			) {
				return { code: 1, stdout: "", stderr: "GraphQL: API rate limit exceeded" };
			}
			if (command === "gh" && args.join(" ") === "repo set-default --view") {
				return { code: 0, stdout: "", stderr: "X No default remote repository has been set" };
			}
			if (command === "git" && args.join(" ") === "remote") {
				return { code: 0, stdout: "origin\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "remote get-url origin") {
				return { code: 0, stdout: "git@github.com:acme/widgets.git\n", stderr: "" };
			}
			if (command === "gh" && args.join(" ") === "api repos/acme/widgets/pulls/123") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 123,
						head: { ref: "feature/review", repo: { full_name: "acme/widgets" } },
						base: { ref: "main", repo: { full_name: "acme/widgets" } },
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

	assert.equal(harness.notifications.length, 0);
	assert.equal(harness.sentMessages.length, 1);
	assert.match(harness.sentMessages[0], /pr: 123/);
	assert.match(harness.sentMessages[0], /current-branch: feature\/review/);
	assert.match(harness.sentMessages[0], /diff --git a\/src\/app.ts b\/src\/app.ts/);
	assert.ok(
		harness.execCalls.some(
			({ command, args }) => command === "gh" && args.join(" ") === "api repos/acme/widgets/pulls/123",
		),
		"should fetch PR metadata via REST when GraphQL is rate-limited",
	);
});

test("/review pr falls back to REST diff when gh pr diff hits a GraphQL rate limit after checkout", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-pr-rest-diff-");
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
				return { code: 0, stdout: "main\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "status --porcelain") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "gh" && args.join(" ") === "pr checkout 123") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "gh" && args.join(" ") === "pr diff 123") {
				return { code: 1, stdout: "", stderr: "GraphQL: quota exceeded\nmore detail" };
			}
			if (command === "gh" && args.join(" ") === "repo set-default --view") {
				return { code: 0, stdout: "", stderr: "X No default remote repository has been set" };
			}
			if (command === "git" && args.join(" ") === "remote") {
				return { code: 0, stdout: "origin\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "remote get-url origin") {
				return { code: 0, stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
			}
			if (
				command === "gh" &&
				args.join(" ") === "api -H Accept: application/vnd.github.v3.diff repos/acme/widgets/pulls/123"
			) {
				return { code: 0, stdout: "diff --git a/src/rest.ts b/src/rest.ts\n", stderr: "" };
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
	assert.match(harness.sentMessages[0], /checkout: switched-from main/);
	assert.match(harness.sentMessages[0], /diff --git a\/src\/rest.ts b\/src\/rest.ts/);
	assert.ok(
		harness.execCalls.findIndex(({ command, args }) => command === "gh" && args.join(" ") === "pr checkout 123") <
			harness.execCalls.findIndex(
				({ command, args }) =>
					command === "gh" &&
					args.join(" ") === "api -H Accept: application/vnd.github.v3.diff repos/acme/widgets/pulls/123",
			),
		"should preserve the checkout-before-diff behavior when falling back to REST diff",
	);
	assert.equal(
		harness.execCalls.some(({ command, args }) => command === "git" && args[0] === "checkout"),
		false,
	);
});

test("/review pr reports both the GraphQL limit and REST fallback resolution failure", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-pr-rest-view-error-");
	const customResponses = ["pr"];

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
				args.join(" ") === "pr view 123 --json number,headRefName,baseRefName,isCrossRepository,headRepository"
			) {
				return { code: 1, stdout: "", stderr: "GraphQL: quota exceeded" };
			}
			if (command === "gh" && args.join(" ") === "repo set-default --view") {
				return { code: 0, stdout: "", stderr: "X No default remote repository has been set" };
			}
			if (command === "git" && args.join(" ") === "remote") {
				return { code: 0, stdout: "", stderr: "" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 0);
	assert.deepEqual(harness.notifications, [
		{
			message:
				"gh pr view hit a GraphQL quota/rate-limit error for '123': GraphQL: quota exceeded. REST fallback could not resolve the PR target: could not resolve GitHub repository because this repo has no git remotes",
			level: "error",
		},
	]);
});

test("/review pr reports the branch switch when gh pr diff fails after checkout", async (t) => {
	const cwd = makeTempDir(t, "tlh-review-pr-diff-failure-");
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
				return { code: 0, stdout: "main\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "status --porcelain") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "gh" && args.join(" ") === "pr checkout 123") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (command === "gh" && args.join(" ") === "pr diff 123") {
				return { code: 1, stdout: "", stderr: "GraphQL: something exploded\nmore detail" };
			}
			throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
		},
	});

	await harness.handler("", harness.ctx);

	assert.equal(harness.sentMessages.length, 0);
	assert.deepEqual(harness.notifications, [
		{
			message:
				"gh pr diff failed for PR #123: GraphQL: something exploded\n/review already switched from 'main' to 'feature/review' before the failure. Use `git checkout -` to return to 'main'.",
			level: "error",
		},
	]);
	assert.ok(
		harness.execCalls.findIndex(({ command, args }) => command === "gh" && args.join(" ") === "pr checkout 123") <
			harness.execCalls.findIndex(({ command, args }) => command === "gh" && args.join(" ") === "pr diff 123"),
		"should switch branches before the diff failure",
	);
	assert.equal(
		harness.execCalls.some(({ command, args }) => command === "git" && args[0] === "checkout"),
		false,
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
