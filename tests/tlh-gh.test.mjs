import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const scriptPath = join(repoRoot, "scripts", "tlh-gh.mjs");

function makeFixture(t) {
	const root = mkdtempSync(join(tmpdir(), "tlh-gh-test-"));
	const binDir = join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const ghScenarioPath = join(root, "gh-scenario.json");
	const gitScenarioPath = join(root, "git-scenario.json");
	const ghLogPath = join(root, "gh-log.jsonl");
	const ghStdinLogPath = join(root, "gh-stdin-log.jsonl");
	const gitLogPath = join(root, "git-log.jsonl");
	const ghPath = join(binDir, "gh");
	const gitPath = join(binDir, "git");

	writeExecutable(
		ghPath,
		`#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const stdin = readFileSync(0, "utf8");
appendFileSync(process.env.TLH_FAKE_GH_LOG, JSON.stringify(args) + "\\n");
appendFileSync(process.env.TLH_FAKE_GH_STDIN_LOG, JSON.stringify(stdin) + "\\n");
const scenario = JSON.parse(readFileSync(process.env.TLH_FAKE_GH_SCENARIO, "utf8"));
const handler = scenario.find((entry) => !entry.args || JSON.stringify(entry.args) === JSON.stringify(args));
if (!handler) {
	process.stderr.write('unexpected gh args: ' + JSON.stringify(args));
	process.exit(90);
}
if (handler.stdout) process.stdout.write(handler.stdout);
if (handler.stderr) process.stderr.write(handler.stderr);
process.exit(handler.exitCode ?? 0);
`,
	);

	writeExecutable(
		gitPath,
		`#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.TLH_FAKE_GIT_LOG, JSON.stringify(args) + "\\n");
const scenario = JSON.parse(readFileSync(process.env.TLH_FAKE_GIT_SCENARIO, "utf8"));
const handler = scenario.find((entry) => JSON.stringify(entry.args) === JSON.stringify(args));
if (!handler) {
	process.stderr.write('unexpected git args: ' + JSON.stringify(args));
	process.exit(91);
}
if (handler.stdout) process.stdout.write(handler.stdout);
if (handler.stderr) process.stderr.write(handler.stderr);
process.exit(handler.exitCode ?? 0);
`,
	);

	t.after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	return {
		root,
		ghScenarioPath,
		gitScenarioPath,
		ghLogPath,
		gitLogPath,
		run(args, { ghScenario = [], gitScenario = [], cwd = root } = {}) {
			writeFileSync(ghScenarioPath, `${JSON.stringify(ghScenario, null, 2)}\n`);
			writeFileSync(gitScenarioPath, `${JSON.stringify(gitScenario, null, 2)}\n`);
			writeFileSync(ghLogPath, "");
			writeFileSync(ghStdinLogPath, "");
			writeFileSync(gitLogPath, "");
			return spawnSync(process.execPath, [scriptPath, ...args], {
				cwd,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${binDir}:${process.env.PATH || ""}`,
					TLH_FAKE_GH_SCENARIO: ghScenarioPath,
					TLH_FAKE_GH_LOG: ghLogPath,
					TLH_FAKE_GH_STDIN_LOG: ghStdinLogPath,
					TLH_FAKE_GIT_SCENARIO: gitScenarioPath,
					TLH_FAKE_GIT_LOG: gitLogPath,
				},
			});
		},
		readGhLog() {
			return readLogLines(ghLogPath);
		},
		readGhStdinLog() {
			return readLogLines(ghStdinLogPath);
		},
		readGitLog() {
			return readLogLines(gitLogPath);
		},
	};
}

function writeExecutable(path, content) {
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

function readLogLines(path) {
	const content = readFileSync(path, "utf8").trim();
	if (!content) return [];
	return content.split("\n").map((line) => JSON.parse(line));
}

function httpResponse(body, { status = 200, headers = {} } = {}) {
	const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
	return [`HTTP/1.1 ${status} OK`, ...headerLines, "", body].join("\n");
}

test("repo view uses explicit --repo and builds a REST gh api request", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["repo", "view", "--repo", "acme/widgets"], {
		ghScenario: [
			{
				args: ["api", "--method", "GET", "--include", "/repos/acme/widgets"],
				stdout: httpResponse('{"full_name":"acme/widgets"}'),
			},
		],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { full_name: "acme/widgets" });
	assert.deepEqual(fixture.readGhLog(), [["api", "--method", "GET", "--include", "/repos/acme/widgets"]]);
	assert.deepEqual(fixture.readGitLog(), []);
});

test("repo inference accepts common HTTPS and SSH GitHub remotes safely", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["pr", "view", "42"], {
		ghScenario: [
			{
				args: ["api", "--method", "GET", "--include", "/repos/octo/tools/pulls/42"],
				stdout: httpResponse('{"number":42}'),
			},
		],
		gitScenario: [
			{ args: ["remote"], stdout: "origin\nupstream\n" },
			{ args: ["remote", "get-url", "origin"], stdout: "https://example.com/not-github/repo.git\n" },
			{ args: ["remote", "get-url", "upstream"], stdout: "git@github.com:octo/tools.git\n" },
		],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { number: 42 });
	assert.deepEqual(fixture.readGitLog(), [
		["remote"],
		["remote", "get-url", "origin"],
		["remote", "get-url", "upstream"],
	]);
});

test("issue list filters pull requests and keeps paginating until the issue limit", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["issue", "list", "--repo", "acme/widgets", "--per-page", "2", "--limit", "3"], {
		ghScenario: [
			{
				args: ["api", "--method", "GET", "--include", "/repos/acme/widgets/issues?per_page=2&page=1"],
				stdout: httpResponse('[{"id":100,"pull_request":{"url":"pr"}},{"id":1}]', {
					headers: {
						Link: '<https://api.github.com/repos/acme/widgets/issues?per_page=2&page=2>; rel="next"',
					},
				}),
			},
			{
				args: ["api", "--method", "GET", "--include", "/repos/acme/widgets/issues?per_page=2&page=2"],
				stdout: httpResponse('[{"id":101,"pull_request":{"url":"pr"}},{"id":2}]', {
					headers: {
						Link: '<https://api.github.com/repos/acme/widgets/issues?per_page=2&page=3>; rel="next"',
					},
				}),
			},
			{
				args: ["api", "--method", "GET", "--include", "/repos/acme/widgets/issues?per_page=2&page=3"],
				stdout: httpResponse('[{"id":3},{"id":4}]'),
			},
		],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), [{ id: 1 }, { id: 2 }, { id: 3 }]);
	assert.equal(fixture.readGhLog().length, 3);
});

test("checks aggregates wrapped check_runs pagination", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["checks", "deadbeef", "--repo", "acme/widgets", "--per-page", "2", "--limit", "3"], {
		ghScenario: [
			{
				args: ["api", "--method", "GET", "--include", "/repos/acme/widgets/commits/deadbeef/check-runs?per_page=2&page=1"],
				stdout: httpResponse('{"total_count":4,"check_runs":[{"id":10},{"id":11}]}', {
					headers: {
						Link: '<https://api.github.com/repos/acme/widgets/commits/deadbeef/check-runs?per_page=2&page=2>; rel="next"',
					},
				}),
			},
			{
				args: ["api", "--method", "GET", "--include", "/repos/acme/widgets/commits/deadbeef/check-runs?per_page=2&page=2"],
				stdout: httpResponse('{"total_count":4,"check_runs":[{"id":12},{"id":13}]}'),
			},
		],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		total_count: 4,
		check_runs: [{ id: 10 }, { id: 11 }, { id: 12 }],
	});
});

test("pr diff requests REST diff media type and prints raw diff", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["pr", "diff", "9", "--repo", "acme/widgets"], {
		ghScenario: [
			{
				args: [
					"api",
					"--method",
					"GET",
					"--include",
					"-H",
					"Accept: application/vnd.github.v3.diff",
					"/repos/acme/widgets/pulls/9",
				],
				stdout: httpResponse("diff --git a/a b/a\n+line\n"),
			},
		],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "diff --git a/a b/a\n+line\n");
});

test("unsupported GraphQL-only operations fail clearly", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["pr", "review-threads", "9", "--repo", "acme/widgets"]);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /unsupported in this REST-first helper/i);
	assert.match(result.stderr, /GraphQL-only/i);
});

test("malformed REST responses fail with actionable diagnostics", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["statuses", "main", "--repo", "acme/widgets"], {
		ghScenario: [
			{
				args: ["api", "--method", "GET", "--include", "/repos/acme/widgets/commits/main/status"],
				stdout: httpResponse("not-json"),
			},
		],
	});

	assert.equal(result.status, 1);
	assert.match(result.stderr, /malformed data/i);
	assert.match(result.stderr, /not-json/);
});

test("quota and auth failures redact secrets and point to next steps", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["repo", "view", "--repo", "acme/widgets"], {
		ghScenario: [
			{
				args: ["api", "--method", "GET", "--include", "/repos/acme/widgets"],
				stderr: "gh: API rate limit exceeded for github_pat_super_secret Authorization: Bearer ghp_deadbeef\n",
				exitCode: 1,
			},
		],
	});

	assert.equal(result.status, 1);
	assert.doesNotMatch(result.stderr, /github_pat_super_secret|ghp_deadbeef/);
	assert.match(result.stderr, /Run 'gh auth status'/);
	assert.match(result.stderr, /rate-limit/);
});

test("issue and pull request identifiers must be positive integers", (t) => {
	const fixture = makeFixture(t);
	for (const args of [
		["issue", "view", "0", "--repo", "acme/widgets"],
		["issue", "comments", "../1", "--repo", "acme/widgets"],
		["pr", "view", "1.5", "--repo", "acme/widgets"],
		["pr", "diff", "1?x=y", "--repo", "acme/widgets"],
		["pr", "reviews", "1/2", "--repo", "acme/widgets"],
		["pr", "comments", "abc", "--repo", "acme/widgets"],
	]) {
		const result = fixture.run(args);
		assert.equal(result.status, 1, `${args.join(" ")} should fail`);
		assert.match(result.stderr, /must be a positive integer/i);
		assert.deepEqual(fixture.readGhLog(), []);
	}
});

test("explicit repository parts reject path and query manipulation", (t) => {
	const fixture = makeFixture(t);
	for (const args of [
		["repo", "view", "--repo", "acme/widgets?per_page=1"],
		["repo", "view", "--repo", "acme/../widgets"],
		["repo", "view", "--owner", "acme%2Fother", "--name", "widgets"],
		["repo", "view", "--owner", "acme", "--name", "widgets#fragment"],
	]) {
		const result = fixture.run(args);
		assert.equal(result.status, 1, `${args.join(" ")} should fail`);
		assert.match(result.stderr, /Repository must be in owner\/repo form|Invalid GitHub repository/i);
		assert.deepEqual(fixture.readGhLog(), []);
	}
});

test("repository inference skips GitHub remotes with unsafe path segments", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["repo", "view"], {
		gitScenario: [
			{ args: ["remote"], stdout: "origin\n" },
			{ args: ["remote", "get-url", "origin"], stdout: "https://github.com/acme/widgets%3Fpage=2.git\n" },
		],
	});

	assert.equal(result.status, 1);
	assert.match(result.stderr, /Could not infer a GitHub owner\/repo/i);
	assert.deepEqual(fixture.readGhLog(), []);
});

test("zero-positional commands reject unused extra arguments", (t) => {
	const fixture = makeFixture(t);
	for (const args of [
		["rate-limit", "unused"],
		["repo", "view", "unused", "--repo", "acme/widgets"],
		["issue", "list", "unused", "--repo", "acme/widgets"],
		["pr", "list", "unused", "--repo", "acme/widgets"],
	]) {
		const result = fixture.run(args);
		assert.equal(result.status, 1, `${args.join(" ")} should fail`);
		assert.match(result.stderr, /Unexpected positional argument/i);
		assert.deepEqual(fixture.readGhLog(), []);
	}
});

test("issue create sends JSON input without shell interpolation and returns stable JSON", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run([
		"issue",
		"create",
		"--repo",
		"acme/widgets",
		"--title",
		"Bug: body stays literal",
		"--body",
		"line 1\n$(rm -rf /)\n--flag-like",
	], {
		ghScenario: [
			{
				args: [
					"api",
					"--method",
					"POST",
					"--include",
					"-H",
					"Content-Type: application/json",
					"--input",
					"-",
					"/repos/acme/widgets/issues",
				],
				stdout: httpResponse('{"number":17,"html_url":"https://github.com/acme/widgets/issues/17"}', { status: 201 }),
			},
		],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		operation: "issue.create",
		repository: "acme/widgets",
		issue: { number: 17, html_url: "https://github.com/acme/widgets/issues/17" },
	});
	assert.deepEqual(fixture.readGhLog(), [[
		"api",
		"--method",
		"POST",
		"--include",
		"-H",
		"Content-Type: application/json",
		"--input",
		"-",
		"/repos/acme/widgets/issues",
	]]);
	assert.deepEqual(fixture.readGhStdinLog(), [JSON.stringify({
		title: "Bug: body stays literal",
		body: "line 1\n$(rm -rf /)\n--flag-like",
	})]);
});

test("issue comment accepts empty body-file content exactly", (t) => {
	const fixture = makeFixture(t);
	const bodyPath = join(fixture.root, "empty-body.md");
	writeFileSync(bodyPath, "");
	const result = fixture.run([
		"issue",
		"comment",
		"7",
		"--repo",
		"acme/widgets",
		"--body-file",
		bodyPath,
	], {
		ghScenario: [
			{
				args: [
					"api",
					"--method",
					"POST",
					"--include",
					"-H",
					"Content-Type: application/json",
					"--input",
					"-",
					"/repos/acme/widgets/issues/7/comments",
				],
				stdout: httpResponse('{"id":70,"body":""}', { status: 201 }),
			},
		],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		operation: "issue.comment",
		repository: "acme/widgets",
		comment: { id: 70, body: "" },
	});
	assert.deepEqual(fixture.readGhStdinLog(), [JSON.stringify({ body: "" })]);
});

test("pr create sends required fields with draft mode and body-file content", (t) => {
	const fixture = makeFixture(t);
	const bodyPath = join(fixture.root, "pr-body.md");
	writeFileSync(bodyPath, "Summary\n\n- item 1\n");
	const result = fixture.run([
		"pr",
		"create",
		"--repo",
		"acme/widgets",
		"--title",
		"Add REST mutations",
		"--base",
		"main",
		"--head",
		"diego:rest-mutations",
		"--body-file",
		bodyPath,
		"--draft",
	], {
		ghScenario: [
			{
				args: [
					"api",
					"--method",
					"POST",
					"--include",
					"-H",
					"Content-Type: application/json",
					"--input",
					"-",
					"/repos/acme/widgets/pulls",
				],
				stdout: httpResponse('{"number":88,"draft":true,"head":{"ref":"rest-mutations"}}', { status: 201 }),
			},
		],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		operation: "pr.create",
		repository: "acme/widgets",
		pullRequest: { number: 88, draft: true, head: { ref: "rest-mutations" } },
	});
	assert.deepEqual(fixture.readGhStdinLog(), [JSON.stringify({
		title: "Add REST mutations",
		base: "main",
		head: "diego:rest-mutations",
		body: "Summary\n\n- item 1\n",
		draft: true,
	})]);
});

test("pr comment uses issue comments REST endpoint and returns stable JSON", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run([
		"pr",
		"comment",
		"21",
		"--repo",
		"acme/widgets",
		"--body",
		"Looks good to me",
	], {
		ghScenario: [
			{
				args: [
					"api",
					"--method",
					"POST",
					"--include",
					"-H",
					"Content-Type: application/json",
					"--input",
					"-",
					"/repos/acme/widgets/issues/21/comments",
				],
				stdout: httpResponse('{"id":210,"body":"Looks good to me"}', { status: 201 }),
			},
		],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		operation: "pr.comment",
		repository: "acme/widgets",
		comment: { id: 210, body: "Looks good to me" },
	});
});

test("mutation validation rejects missing required and conflicting flags before gh runs", (t) => {
	const fixture = makeFixture(t);
	const bodyPath = join(fixture.root, "body.md");
	writeFileSync(bodyPath, "body");
	for (const [args, pattern] of [
		[["issue", "create", "--repo", "acme/widgets"], /--title is required/i],
		[["issue", "comment", "7", "--repo", "acme/widgets"], /exactly one of --body or --body-file/i],
		[["issue", "comment", "7", "--repo", "acme/widgets", "--body", "x", "--body-file", bodyPath], /either --body or --body-file, not both/i],
		[["pr", "create", "--repo", "acme/widgets", "--title", "x", "--head", "me:branch"], /--base is required/i],
		[["pr", "create", "--repo", "acme/widgets", "--title", "x", "--base", "main"], /--head is required/i],
	]) {
		const result = fixture.run(args);
		assert.equal(result.status, 1, `${args.join(" ")} should fail`);
		assert.match(result.stderr, pattern);
		assert.deepEqual(fixture.readGhLog(), []);
	}
});

test("mutation API failures redact secrets and keep auth guidance", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run([
		"pr",
		"create",
		"--repo",
		"acme/widgets",
		"--title",
		"x",
		"--base",
		"main",
		"--head",
		"me:branch",
	], {
		ghScenario: [
			{
				args: [
					"api",
					"--method",
					"POST",
					"--include",
					"-H",
					"Content-Type: application/json",
					"--input",
					"-",
					"/repos/acme/widgets/pulls",
				],
				stdout: httpResponse('{"message":"bad token github_pat_hidden_value"}', { status: 422 }),
			},
		],
	});

	assert.equal(result.status, 1);
	assert.match(result.stderr, /gh api POST \/repos\/acme\/widgets\/pulls failed/i);
	assert.match(result.stderr, /Run 'gh auth status'/);
	assert.doesNotMatch(result.stderr, /github_pat_hidden_value/);
});

test("help documents tlh github usage plus implemented list filters and pagination flags", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["--help"]);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Usage: tlh github <command> \[options\]/);
	for (const flag of ["--labels", "--creator", "--assignee", "--since", "--page", "--title", "--body-file", "--draft"]) {
		assert.match(result.stdout, new RegExp(flag));
	}
});

test("non-2xx HTTP responses fail even when gh exits zero and redact response secrets", (t) => {
	const fixture = makeFixture(t);
	const result = fixture.run(["repo", "view", "--repo", "acme/widgets"], {
		ghScenario: [
			{
				args: ["api", "--method", "GET", "--include", "/repos/acme/widgets"],
				stdout: httpResponse('{"message":"rate limit for github_pat_response_secret"}', { status: 403 }),
			},
		],
	});

	assert.equal(result.status, 1);
	assert.match(result.stderr, /HTTP 403/);
	assert.match(result.stderr, /rate-limit/);
	assert.doesNotMatch(result.stderr, /github_pat_response_secret/);
});
