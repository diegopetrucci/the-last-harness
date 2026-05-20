import assert from "node:assert/strict";
import test from "node:test";

import { composeTlhFooterFirstLine } from "../extensions/the-last-harness/footer-first-line.ts";

const CWD = "~/repo";

test("no cache and no fallback branch yields just the cwd", () => {
	const line = composeTlhFooterFirstLine({ cwd: CWD });
	assert.equal(line, CWD);
});

test("no cache, no fallback branch, but a session name appends the session", () => {
	const line = composeTlhFooterFirstLine({ cwd: CWD, sessionName: "my-session" });
	assert.equal(line, "~/repo • my-session");
});

test("no cache but footerData branch falls back with bullet (no parens)", () => {
	const line = composeTlhFooterFirstLine({ cwd: CWD, fallbackBranch: "main" });
	assert.equal(line, "~/repo • main");
	assert.ok(!line.includes("("), "fallback must not use legacy parenthesized format");
});

test("cache snapshot with branch only renders cwd • branch", () => {
	const line = composeTlhFooterFirstLine({
		cwd: CWD,
		status: {
			branch: "main",
			staged: 0,
			unstaged: 0,
			untracked: 0,
			conflict: 0,
			ahead: 0,
			behind: 0,
		},
	});
	assert.equal(line, "~/repo • main");
});

test("cache snapshot with status indicators renders branch + indicators", () => {
	const line = composeTlhFooterFirstLine({
		cwd: CWD,
		status: {
			branch: "main",
			staged: 1,
			unstaged: 2,
			untracked: 1,
			conflict: 0,
			ahead: 1,
			behind: 0,
		},
	});
	assert.equal(line, "~/repo • main • +1 ~2 ?1 ↑1");
});

test("cache snapshot with status + PR renders branch • indicators • PR #N", () => {
	const line = composeTlhFooterFirstLine({
		cwd: CWD,
		status: {
			branch: "main",
			staged: 1,
			unstaged: 2,
			untracked: 1,
			conflict: 0,
			ahead: 1,
			behind: 0,
		},
		pullRequest: { number: 42, state: "OPEN", isDraft: false },
	});
	assert.equal(line, "~/repo • main • +1 ~2 ?1 ↑1 • PR #42");
});

test("cache snapshot with branch + PR renders cwd • branch • PR #N", () => {
	const line = composeTlhFooterFirstLine({
		cwd: CWD,
		status: {
			branch: "main",
			staged: 0,
			unstaged: 0,
			untracked: 0,
			conflict: 0,
			ahead: 0,
			behind: 0,
		},
		pullRequest: { number: 42 },
	});
	assert.equal(line, "~/repo • main • PR #42");
});

test("session name appends after PR with bullet divider", () => {
	const line = composeTlhFooterFirstLine({
		cwd: CWD,
		sessionName: "my-session",
		status: {
			branch: "main",
			staged: 1,
			unstaged: 2,
			untracked: 1,
			conflict: 0,
			ahead: 1,
			behind: 0,
		},
		pullRequest: { number: 42 },
	});
	assert.equal(line, "~/repo • main • +1 ~2 ?1 ↑1 • PR #42 • my-session");
});

test("cache snapshot wins over fallback branch", () => {
	const line = composeTlhFooterFirstLine({
		cwd: CWD,
		fallbackBranch: "stale-branch",
		status: {
			branch: "main",
			staged: 0,
			unstaged: 0,
			untracked: 0,
			conflict: 0,
			ahead: 0,
			behind: 0,
		},
	});
	assert.equal(line, "~/repo • main");
});

test("cache snapshot with no branch and no indicators yields just cwd", () => {
	// e.g. running outside a git worktree: status object exists but is empty.
	const line = composeTlhFooterFirstLine({
		cwd: CWD,
		status: {
			branch: undefined,
			staged: 0,
			unstaged: 0,
			untracked: 0,
			conflict: 0,
			ahead: 0,
			behind: 0,
		},
	});
	assert.equal(line, CWD);
});

test("acceptance: current working tree (one untracked file) renders branch + ?1", () => {
	const line = composeTlhFooterFirstLine({
		cwd: "~/Developer/the-last-harness-mine",
		status: {
			branch: "main",
			staged: 0,
			unstaged: 0,
			untracked: 1,
			conflict: 0,
			ahead: 0,
			behind: 0,
		},
	});
	assert.equal(line, "~/Developer/the-last-harness-mine • main • ?1");
});
