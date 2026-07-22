import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));

function readAgentPrompt(group, name) {
	return readFileSync(resolve(testDir, "..", "agents", group, `${name}.md`), "utf8");
}

function assertIncludesAllTerms(body, label, terms) {
	for (const term of terms) {
		assert.match(body, new RegExp(escapeRegExp(term), "i"), `${label} should include ${term}`);
	}
}

function assertOrderedTerms(body, label, terms) {
	let lastIndex = -1;
	for (const term of terms) {
		const index = body.toLowerCase().indexOf(term.toLowerCase(), lastIndex + 1);
		assert.notEqual(index, -1, `${label} should include ${term}`);
		assert.ok(index > lastIndex, `${label} should keep ${term} after earlier terms`);
		lastIndex = index;
	}
}

function assertBodyPattern(body, label, pattern) {
	assert.match(body, pattern, `${label} should match ${pattern}`);
}

function assertExcludesAllTerms(body, label, terms) {
	for (const term of terms) {
		assert.doesNotMatch(body, new RegExp(escapeRegExp(term), "i"), `${label} should not include ${term}`);
	}
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("architect prompt keeps bounded REST CI polling guidance", () => {
	const agent = readAgentPrompt("primary", "architect");

	assertBodyPattern(
		agent,
		"architect cleanup guidance",
		/use bounded REST `gh api` polling for check-runs and commit statuses rather than `gh pr checks --watch`/i,
	);
	assertBodyPattern(agent, "architect cleanup guidance", /do not investigate the failure, edit code, commit, or push follow-up changes unless the user explicitly asks/i);
});

test("rush prompt keeps bounded REST CI polling guidance", () => {
	const agent = readAgentPrompt("primary", "rush");

	assertBodyPattern(
		agent,
		"rush cleanup guidance",
		/use bounded REST `gh api` polling for check-runs and commit statuses rather than `gh pr checks --watch`/i,
	);
	assertBodyPattern(agent, "rush cleanup guidance", /do not investigate the failure, edit code, commit, or push follow-up changes unless the user explicitly asks/i);
});

test("librarian prompt keeps REST-first GitHub research quota guidance", () => {
	const agent = readAgentPrompt("subagents", "librarian");

	assertIncludesAllTerms(agent, "shared quota preflight guidance", [
		"gh api rate_limit 2>&1",
		"all local TLH sessions share the same authenticated GitHub GraphQL quota",
		"REST/core quota can still remain available after GraphQL is low or exhausted",
	]);
	assertOrderedTerms(agent, "REST-first inspection coverage", [
		"prefer them over GraphQL-backed convenience commands",
		"PRs",
		"issues",
		"releases",
		"review comments",
		"commit statuses",
		"check-runs",
	]);
	assertBodyPattern(agent, "avoid statusCheckRollup", /avoid `?statusCheckRollup`?/i);
	assertBodyPattern(agent, "ban gh pr checks watch", /avoid `gh pr checks --watch`/i);
	assertBodyPattern(agent, "REST fallback on GraphQL failure", /fall back to `gh api` GET requests against REST endpoints or to local `git` evidence when possible/i);
});

test("architect prompt preserves pre-existing changes without weakening the no-edit boundary", () => {
	const agent = readAgentPrompt("primary", "architect");

	assertIncludesAllTerms(agent, "architect preservation guidance", [
		"Do not directly edit source files. Implementation belongs to `developer`.",
		"Preserve pre-existing worktree and index changes as human-owned state.",
		"Do not discard, overwrite, revert, stage, or otherwise clean them up on your own.",
		"`git stash`",
		"`git restore`",
		"`git reset`",
		"non-dry-run `git clean`",
		"checkout/switch discard or force options when they would affect pre-existing state",
		"ask the user how to proceed instead.",
	]);
});

test("developer prompt preserves human-owned changes and limits escalation to blocking overlap", () => {
	const agent = readAgentPrompt("subagents", "developer");

	assertIncludesAllTerms(agent, "developer preservation guidance", [
		"Plan approval or ticket approval is not authorization to mutate, revert, overwrite, or clean up pre-existing worktree or index changes you did not create for the current task.",
		"Touch them only with scoped user authorization given directly or relayed by the architect",
		"the architect cannot independently authorize discarding human-owned changes.",
		"`git stash`",
		"`git restore`",
		"`git reset`",
		"non-dry-run `git clean`",
		"checkout/switch discard or force options against pre-existing state without that authorization.",
		"Preserve unrelated state while implementing the ticket.",
		"pre-existing changes overlap the task and block a safe, scoped implementation",
	]);
});

test("code-reviewer prompt matches current review-only guidance without removed quota sections", () => {
	const agent = readAgentPrompt("subagents", "code-reviewer");

	assertIncludesAllTerms(agent, "review inputs guidance", [
		"Use `git diff --no-color`, `git diff --cached --no-color`, and `git status --short --untracked-files=all`.",
		"Inspect relevant untracked new files when needed so the review covers pre-staging changes.",
		"If the repository is unfamiliar and review quality depends on understanding stack or conventions, ask the delegating primary agent to provide a `repo-scout` report.",
	]);
	assertIncludesAllTerms(agent, "review output guidance", [
		"Use `contact_supervisor` only if a required review decision is blocked by missing context or conflicting instructions.",
		"For each required fix include:",
		"Do not include optional suggestions, style nitpicks, praise sections, or generic checklists.",
	]);
	assertExcludesAllTerms(agent, "removed GitHub quota guidance", [
		"gh api rate_limit 2>&1",
		"all local TLH sessions share the same authenticated GitHub GraphQL quota",
		"gh pr checks --watch",
		"statusCheckRollup",
	]);
});
