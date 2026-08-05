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

test("scout and research subagent prompts keep bounded scope and tool budgets", () => {
	const librarian = readAgentPrompt("subagents", "librarian");
	const repoScout = readAgentPrompt("subagents", "repo-scout");
	const diffSummarizer = readAgentPrompt("subagents", "diff-summarizer");
	const webScout = readAgentPrompt("subagents", "web-scout");

	assertBodyPattern(librarian, "librarian tool budget", /toolBudget:\s*\{"soft":30,"hard":60\}/i);
	assertBodyPattern(repoScout, "repo-scout tool budget", /toolBudget:\s*\{"soft":20,"hard":30\}/i);
	assertBodyPattern(diffSummarizer, "diff-summarizer tool budget", /toolBudget:\s*\{"soft":12,"hard":20\}/i);
	assertBodyPattern(webScout, "web-scout tool budget", /toolBudget:\s*\{"soft":5,"hard":7\}/i);

	assertIncludesAllTerms(librarian, "librarian bounded scope guidance", [
		"Stay tightly scoped",
		"Do not broaden into general web research",
		"Stop as soon as the question is answered",
	]);
	assertIncludesAllTerms(repoScout, "repo-scout bounded scope guidance", [
		"Stay limited to repository orientation",
		"Inspect only the minimum representative files needed",
		"Stop once you can give a confident orientation report",
	]);
	assertIncludesAllTerms(diffSummarizer, "diff-summarizer bounded scope guidance", [
		"Stay limited to the supplied diff or current local change set",
		"do not drift into implementation planning",
		"Stop once the main behavior changes, risky areas, and requirement status are covered",
	]);
	assertIncludesAllTerms(webScout, "web-scout bounded scope guidance", [
		"Stay tightly scoped to the architect's stated research question",
		"Do not broaden into GitHub-specific repository archaeology",
		"Stop once the question is answered",
	]);

	assertIncludesAllTerms(librarian, "shared quota preflight guidance", [
		"gh api rate_limit 2>&1",
		"all local TLH sessions share the same authenticated GitHub GraphQL quota",
		"REST/core quota can still remain available after GraphQL is low or exhausted",
	]);
	assertOrderedTerms(librarian, "REST-first inspection coverage", [
		"prefer them over GraphQL-backed convenience commands",
		"PRs",
		"issues",
		"releases",
		"review comments",
		"commit statuses",
		"check-runs",
	]);
	assertBodyPattern(librarian, "avoid statusCheckRollup", /avoid `?statusCheckRollup`?/i);
	assertBodyPattern(librarian, "ban gh pr checks watch", /avoid `gh pr checks --watch`/i);
	assertBodyPattern(librarian, "REST fallback on GraphQL failure", /fall back to `gh api` GET requests against REST endpoints or to local `git` evidence when possible/i);
});

test("architect prompt preserves pre-existing changes and async steering guidance", () => {
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
	assertIncludesAllTerms(agent, "architect async steering guidance", [
		"Prefer the narrowest subagent and task framing",
		"Treat roughly 4m30 and later long-running notices as non-disruptive status checkpoints",
		"Prefer status/steer over timer-driven pause",
		"If a live async child's scope expands",
		"Pause or interrupt a live child only for real decisions",
		"Repeated checkpoints never reset the cumulative runtime budget",
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

test("developer prompt pins the Luna model and max thinking defaults", () => {
	const agent = readAgentPrompt("subagents", "developer");

	assert.match(agent, /^tlhOpenaiModels: openai-codex\/gpt-5\.6-luna$/m);
	assert.match(agent, /^tlhAnthropicModels: anthropic\/claude-sonnet-4-6$/m);
	assert.match(agent, /^tlhAnthropicThinking: medium$/m);
	assert.match(agent, /^tlhOpenaiThinking: max$/m);
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
