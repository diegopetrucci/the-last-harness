import assert from "node:assert/strict";
import test from "node:test";

import { bodyPattern, readAgentPrompt } from "./agent-prompt-test-helpers.mjs";

const architect = readAgentPrompt("primary", "architect");
const { content: architectMd } = architect;

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

test("architect.md requires specific risk wording and explicit consent before using oracle", () => {
	assert.match(
		architectMd,
		/If you think the `oracle` could help, explain the specific risk or uncertainty and ask the user if they want you to use it\./,
	);
	assert.match(architectMd, /Never trigger the `oracle` unless the user explicitly agrees\./);
});

test("architect.md separates implementation tickets from final validation", () => {
	assert.ok(
		bodyPattern(
			"implementation tickets skip validation",
			/implementation ticket.*do(?:es)? not require tests or validation.*final validation ticket/i,
		).test(architect),
	);
});

test("architect.md makes the final validation ticket depend on implementation tickets and use VALIDATING.md when present", () => {
	assert.ok(
		bodyPattern(
			"final validation ticket uses repository validation guidance",
			/final validation ticket.*depends on all implementation tickets.*when .*VALIDATING\.md.*otherwise.*repo-discovered validation commands/i,
		).test(architect),
	);
});
