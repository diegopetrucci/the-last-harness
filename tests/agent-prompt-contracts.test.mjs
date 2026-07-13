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

test("architect prompt keeps positive tlh github workflow guidance", () => {
	const agent = readAgentPrompt("primary", "architect");

	assertIncludesAllTerms(agent, "architect GitHub workflow guidance", [
		"prefer `tlh github` over raw `gh` or direct API calls",
		"state-changing issue/PR actions such as create and comment only after the user authorizes that action",
		"plain `git clone`",
		"GraphQL-only and unsupported by `tlh github`",
	]);
	assertBodyPattern(
		agent,
		"architect cleanup guidance",
		/use bounded REST `tlh github checks <sha>` \/ `tlh github statuses <sha>` polling for covered workflows rather than `gh pr checks --watch`/i,
	);
	assertBodyPattern(agent, "architect cleanup guidance", /if a needed GitHub check is GraphQL-only, say so clearly instead of implying helper coverage/i);
	assertBodyPattern(agent, "architect cleanup guidance", /do not investigate the failure, edit code, commit, or push follow-up changes unless the user explicitly asks/i);
});

test("rush prompt keeps positive tlh github workflow guidance", () => {
	const agent = readAgentPrompt("primary", "rush");

	assertIncludesAllTerms(agent, "rush GitHub workflow guidance", [
		"prefer `tlh github` over raw `gh` or direct API calls",
		"state-changing issue/PR actions such as create and comment only after the user authorizes that action",
		"plain `git clone`",
		"GraphQL-only and unsupported by `tlh github`",
	]);
	assertBodyPattern(
		agent,
		"rush cleanup guidance",
		/use bounded REST `tlh github checks <sha>` \/ `tlh github statuses <sha>` polling for covered workflows rather than `gh pr checks --watch`/i,
	);
	assertBodyPattern(agent, "rush cleanup guidance", /if a needed GitHub check is GraphQL-only, say so clearly instead of implying helper coverage/i);
	assertBodyPattern(agent, "rush cleanup guidance", /do not investigate the failure, edit code, commit, or push follow-up changes unless the user explicitly asks/i);
});

test("librarian prompt keeps REST-first GitHub research quota guidance", () => {
	const agent = readAgentPrompt("subagents", "librarian");

	assertIncludesAllTerms(agent, "shared quota preflight guidance", [
		"tlh github rate-limit 2>&1",
		"all local TLH sessions share the same authenticated GitHub GraphQL quota",
		"REST/core quota can still remain available after GraphQL is low or exhausted",
	]);
	assertIncludesAllTerms(agent, "REST-first helper coverage", [
		"read-only REST-first `tlh github`",
		"issue view/list/comments",
		"pr view/list/diff/reviews/comments",
		"checks",
		"statuses",
	]);
	assertOrderedTerms(agent, "REST-first inspection coverage", [
		"prefer `tlh github` or bounded `gh api` GET requests over GraphQL-backed convenience commands",
		"PRs",
		"issues",
		"releases",
		"review comments",
		"commit statuses",
		"check-runs",
	]);
	assertBodyPattern(agent, "librarian stays read-only", /do not use `tlh github issue create`, `tlh github issue comment`, `tlh github pr create`, or `tlh github pr comment`/i);
	assertBodyPattern(agent, "plain git clone only", /plain `git clone`/i);
	assertBodyPattern(agent, "graphQL-only limitation guidance", /`tlh github pr review-threads` and `tlh github pr status-check-rollup` remain GraphQL-only limitations/i);
	assertBodyPattern(agent, "avoid statusCheckRollup", /avoid `?statusCheckRollup`?/i);
	assertBodyPattern(agent, "ban gh pr checks watch", /avoid `gh pr checks --watch`/i);
	assertBodyPattern(agent, "REST fallback on GraphQL failure", /fall back to read-only `tlh github` coverage first, then to `gh api` GET requests against REST endpoints or to local `git` evidence when possible/i);
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
