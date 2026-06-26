import assert from "node:assert/strict";
import test from "node:test";

import { bodyPattern, readAgentPrompt } from "./agent-prompt-test-helpers.mjs";

const architect = readAgentPrompt("primary", "architect");
const { content: architectMd, normalizedBody: architectNormalizedBody } = architect;

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

test("architect.md lists contrarian in the base subagent tools list", () => {
	assert.match(
		architectMd,
		/- `contrarian`: adversarially stress-test plans, designs, assumptions, product directions, bug hypotheses, or review conclusions by steelmanning the strongest opposing case\./,
	);
});

test("architect.md includes sparing contrarian routing guidance in the base prompt", () => {
	assert.match(
		architectMd,
		/Use `contrarian` sparingly when a plan, product direction, bug hypothesis, or review conclusion needs an adversarial challenge pass\./,
	);
	assert.match(
		architectMd,
		/It is not the normal diff reviewer — `code-reviewer` owns review against tasks and diffs — and unlike `oracle`, it should focus on the strongest credible opposition brief rather than a broad second opinion\./,
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

test("architect.md includes contrarian pre-ticket planning guidance in the base prompt", () => {
	assert.match(
		architectMd,
		/Pre-ticket planning is the primary useful moment for `contrarian`: consider it before ticket creation only when a proposed change has meaningful uncertainty, tradeoffs, blast radius, a hard-to-undo direction, or debatable assumptions, and name the specific risk or strongest opposing case you want stress-tested\./,
	);
	assert.match(
		architectMd,
		/Do not use `contrarian` as an automatic step for routine localized work; use it sparingly\./,
	);
});

test("architect.md keeps base validation planning ticket-specific", () => {
	assert.ok(
		bodyPattern(
			"ticket-specific validation expectations",
			/ticket-specific validation expectations.*differ from the repository's normal validation flow/i,
		).test(architect),
	);
});

test("architect.md permanently includes the final-validation-ticket workflow", () => {
	assert.match(architectNormalizedBody, /final-validation ticket.*depends on all implementation tickets/i);
	assert.match(architectNormalizedBody, /implementation-ticket validation narrow and ticket-scoped/i);
	assert.match(architectNormalizedBody, /when [`']?VALIDATING\.md[`']? is present.*otherwise use repo-discovered validation commands/i);
	assert.match(architectNormalizedBody, /make any validation deferral explicit in the ticket text/i);
});

test("architect.md keeps delta follow-up review guidance out of the base prompt", () => {
	assert.doesNotMatch(
		architectMd,
		/default the follow-up `code-reviewer` request to the delta since the last reviewed checkpoint instead of rereading the full branch diff\./,
	);
	assert.doesNotMatch(
		architectMd,
		/pass the prior findings plus the exact delta baseline, git range or checkpoint, or explicit changed-file list to review\./,
	);
	assert.doesNotMatch(
		architectMd,
		/Keep or expand to targeted wider review or full re-review for installer or other destructive-path changes, trust-boundary changes, auth or execution changes, unresolved reviewer disagreement, or whenever the delta cannot be validated safely without wider context\./,
	);
});

test("architect.md keeps ordinary final review on the full VCS diff", () => {
	assert.match(architectMd, /Delegate final review to `code-reviewer` against the full VCS diff and completed tickets\./);
});
