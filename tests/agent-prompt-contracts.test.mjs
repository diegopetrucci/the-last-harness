import test from "node:test";

import {
	assertPromptAnchors,
	bodyPattern,
	includesAllTerms,
	orderedTerms,
	readAgentPrompt,
} from "./agent-prompt-test-helpers.mjs";

test("architect prompt keeps REST-first GitHub workflow quota guidance", () => {
	const agent = readAgentPrompt("primary", "architect");

	assertPromptAnchors(agent, [
		includesAllTerms("shared GraphQL quota warning", [
			"all local TLH sessions share the same authenticated GitHub GraphQL quota",
			"REST/core quota can still be available after GraphQL quota is exhausted",
		]),
		orderedTerms("REST-first GitHub workflow coverage", [
			"prefer REST-first `gh api` calls whenever a REST endpoint exists",
			"PR/issue/release creation",
			"comments",
			"status/check inspection",
			"PR review/comment inspection",
		]),
		bodyPattern("avoid GraphQL-heavy convenience commands", /avoid GraphQL-heavy convenience commands such as `gh pr create`, `gh pr comment`, `gh issue create`, `gh issue comment`, `gh repo view`, `gh pr view`, `gh issue view`, `gh release create`, and `gh release view`/i),
		bodyPattern("ban gh pr checks watch", /do not use `gh pr checks --watch`/i),
		bodyPattern("REST polling for CI watch", /bounded REST `gh api` polling .* rather than `gh pr checks --watch`/i),
	]);
});

test("rush prompt keeps REST-first GitHub workflow quota guidance", () => {
	const agent = readAgentPrompt("primary", "rush");

	assertPromptAnchors(agent, [
		includesAllTerms("shared quota fallback guidance", [
			"all local TLH sessions share the same authenticated GitHub GraphQL quota",
			"REST/core quota can remain available after GraphQL is exhausted",
		]),
		includesAllTerms("REST-first workflow coverage", [
			"prefer REST-first `gh api` calls whenever a REST endpoint exists",
			"PR/issue/release workflows",
			"creation",
			"comments",
			"status/check inspection",
			"PR review/comment inspection",
		]),
		bodyPattern("avoid GraphQL-backed convenience commands", /avoid GraphQL-backed `gh` convenience commands/i),
		bodyPattern("ban gh pr checks watch", /do not use `gh pr checks --watch`/i),
		bodyPattern("REST polling for CI watch", /bounded REST `gh api` polling .* rather than `gh pr checks --watch`/i),
	]);
});

test("librarian prompt keeps REST-first GitHub research quota guidance", () => {
	const agent = readAgentPrompt("subagents", "librarian");

	assertPromptAnchors(agent, [
		includesAllTerms("shared quota preflight guidance", [
			"gh api rate_limit 2>&1",
			"all local TLH sessions share the same authenticated GitHub GraphQL quota",
			"REST/core quota can still remain available after GraphQL is low or exhausted",
		]),
		includesAllTerms("REST-first inspection coverage", [
			"prefer them over GraphQL-backed convenience commands",
			"PRs",
			"issues",
			"releases",
			"review comments",
			"commit statuses",
			"check-runs",
		]),
		bodyPattern("avoid statusCheckRollup", /avoid `?statusCheckRollup`?/i),
		bodyPattern("ban gh pr checks watch", /avoid `gh pr checks --watch`/i),
	]);
});

test("code-reviewer prompt keeps REST-first GitHub review quota guidance", () => {
	const agent = readAgentPrompt("subagents", "code-reviewer");

	assertPromptAnchors(agent, [
		includesAllTerms("shared quota preflight guidance", [
			"gh api rate_limit 2>&1",
			"all local TLH sessions share the same authenticated GitHub GraphQL quota",
			"REST/core quota can still remain available after GraphQL is low or exhausted",
		]),
		includesAllTerms("REST-first review coverage", [
			"Prefer REST `gh api` GET endpoints",
			"pull requests",
			"issues",
			"releases",
			"review comments",
			"commit statuses",
			"check-runs",
		]),
		bodyPattern("avoid GraphQL-heavy convenience lookups", /avoid GraphQL-heavy convenience lookups such as `gh pr view`, `gh issue view`, `gh release view`/i),
		bodyPattern("avoid statusCheckRollup", /avoid `?statusCheckRollup`?/i),
		bodyPattern("ban gh pr checks watch", /do not use `gh pr checks --watch`/i),
		bodyPattern("REST fallback on GraphQL failure", /fall back to REST `gh api` GET queries or local git evidence/i),
	]);
});
