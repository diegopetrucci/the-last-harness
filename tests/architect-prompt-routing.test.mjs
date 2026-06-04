import assert from "node:assert/strict";
import test from "node:test";

import { readAgentPrompt } from "./agent-prompt-test-helpers.mjs";

const { content: architectMd } = readAgentPrompt("primary", "architect");

test("architect.md contains validator bullet in the subagent tools list", () => {
	assert.match(
		architectMd,
		/- `validator`: run source-read-only validation commands and report exact commands, outcomes, skipped commands, git status before\/after, and failure triage\./,
	);
});

test("architect.md contains web-scout bullet in the subagent tools list", () => {
	assert.match(
		architectMd,
		/- `web-scout`: research the general web outside GitHub via Exa-backed search and fetch in an isolated read-only context\./,
	);
});

test("architect.md lists librarian and web-scout as allowed minor agents with distinct research scopes", () => {
	assert.match(
		architectMd,
		/- `librarian`: research external GitHub repositories, issues, pull requests, releases, or docs read-only when outside evidence is needed\.\n- `web-scout`: research the general web outside GitHub via Exa-backed search and fetch in an isolated read-only context\./,
	);
});

test("architect.md limits pre-ticket oracle suggestions to higher-risk planning work", () => {
	assert.match(
		architectMd,
		/Only consider the `oracle` before ticket creation when the planning work looks high-stakes, uncertain, hard to validate, hard to undo, or likely to have a broad blast radius\./,
	);
});

test("architect.md excludes routine localized reversible directly testable work from oracle suggestions", () => {
	assert.match(
		architectMd,
		/Do not suggest the `oracle` for routine localized work that is reversible and directly testable\./,
	);
});

test("architect.md routes final review through validator before code-reviewer", () => {
	assert.match(
		architectMd,
		/1\. Delegate source-read-only validation to `validator` against the completed tickets and current worktree\.\n2\. Evaluate the validator report; delegate fixes to `developer` if needed\.\n3\. Delegate final review to `code-reviewer` against the full VCS diff, completed tickets, and validator findings\./,
	);
});

test("architect.md requires specific risk wording and explicit consent before using oracle", () => {
	assert.match(
		architectMd,
		/If you think the `oracle` could help, explain the specific risk or uncertainty and ask the user if they want you to use it\./,
	);
	assert.match(architectMd, /Never trigger the `oracle` unless the user explicitly agrees\./);
});
