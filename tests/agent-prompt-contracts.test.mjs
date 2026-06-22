import assert from "node:assert/strict";
import test from "node:test";

import {
	assertPromptAnchors,
	assertToolContract,
	bodyPattern,
	heading,
	includesAllTerms,
	orderedTerms,
	readAgentPrompt,
} from "./agent-prompt-test-helpers.mjs";

const contracts = [
	{
		group: "primary",
		name: "architect",
		requiredTools: ["read", "grep", "find", "ls", "bash", "subagent", "intercom"],
		forbiddenTools: ["contact_supervisor", "web_search", "fetch_content", "get_search_content", "oracle"],
		anchors: [
			heading("Tools and delegation"),
			heading("Planning and task tracking"),
			heading("Implementation loop"),
			bodyPattern("delegates implementation to developer", /do not directly edit source files/i),
			bodyPattern(
				"architect scopes contrarian as a sparing challenge pass distinct from review and oracle",
				/contrarian.*not the normal diff reviewer.*code-reviewer.*narrower than [`']?oracle[`']?|do not use [`']?contrarian[`']? as the normal diff reviewer.*routine localized work.*use it sparingly/i,
			),
			includesAllTerms(
				"architect keeps contrarian focused on named pre-ticket risks",
				["Pre-ticket planning", "primary useful moment", "specific risk", "strongest opposing case"],
			),
			bodyPattern(
				"paused dispatch stays recoverable and non-authorizing",
				/paused or interrupted developer\/subagent dispatch.*recoverable paused run.*not authorization to edit directly.*resume by run id\/index.*re-dispatch an approved ticket.*ask the user.*or stop.*doctor.*no active run.*stale or failed/i,
			),
			orderedTerms("exact approved signoff gate", ["exact word", "approved"]),
			orderedTerms("developer waits for approved tickets", ["do not launch", "developer", "until", "approves", "tickets"]),
			includesAllTerms("high-risk oracle gating", ["high-stakes", "broad blast radius", "explicitly agrees"]),
			bodyPattern(
				"architect captures only ticket-specific validation deviations",
				/ticket-specific validation expectations.*differ from the repository's normal validation flow/i,
			),
		],
	},
	{
		group: "primary",
		name: "rush",
		requiredTools: ["read", "write", "edit", "grep", "find", "ls", "bash", "subagent", "intercom"],
		forbiddenTools: ["contact_supervisor", "web_search", "fetch_content", "get_search_content", "oracle"],
		anchors: [
			heading("Workflow"),
			heading("Minor subagents"),
			heading("Fit"),
			bodyPattern("Rush edits directly", /edit code directly/i),
			bodyPattern(
				"Rush keeps contrarian as a sparing non-review challenge pass",
				/contrarian.*not the normal diff reviewer.*unlike [`']?oracle[`']?.*use it sparingly/i,
			),
			bodyPattern("Rush never delegates implementation to developer", /do not delegate implementation to [`']?developer[`']?/i),
			orderedTerms("tickets are optional by default", ["do not create or require", "tk", "by default"]),
			bodyPattern("broad work escalates to architect or product", /recommend switching to [`']?architect[`']?|recommend [`']?architect[`']? or [`']?product[`']?/i),
		],
	},
	{
		group: "primary",
		name: "product",
		requiredTools: ["read", "grep", "find", "ls", "bash", "write", "edit", "subagent", "intercom"],
		forbiddenTools: ["contact_supervisor", "web_search", "fetch_content", "get_search_content", "oracle"],
		anchors: [
			heading("Orientation"),
			heading("Scoped subagents"),
			heading("Product workflow"),
			heading("Documentation and ticket standards"),
			bodyPattern("product never implements source changes", /do not edit source code|never implement source changes/i),
			bodyPattern(
				"product scopes contrarian to sparing product stress-tests",
				/contrarian.*product directions.*tradeoffs.*ticket framing.*not code review.*code-reviewer.*narrower than [`']?oracle[`']?/i,
			),
			orderedTerms("writable outputs stay constrained", ["Writable outputs are limited to", "docs/PRODUCT_STRATEGY.md", "`tk` tickets", "AGENTS.md"]),
			orderedTerms("tickets require user signoff", ["user signoff", "tickets"]),
			bodyPattern("product avoids implementation loops and review", /do not delegate implementation, run implementation loops, edit source, or perform code review/i),
		],
	},
	{
		group: "primary",
		name: "bug-hunter",
		requiredTools: ["read", "grep", "find", "ls", "bash", "subagent", "intercom"],
		forbiddenTools: ["write", "edit", "contact_supervisor", "web_search", "fetch_content", "get_search_content", "oracle"],
		anchors: [
			heading("Inputs"),
			heading("Investigation process"),
			heading("Final report"),
			bodyPattern("bug hunter is read-only", /you are read-only|do not modify files/i),
			bodyPattern(
				"bug hunter scopes contrarian to sparing bug-hypothesis stress-tests",
				/contrarian.*bug hypotheses.*strongest opposing case.*does not replace [`']?code-reviewer[`']?.*[`']?oracle[`']?/i,
			),
			orderedTerms("ticket ids are source of truth", ["tk show <id>", "source of truth"]),
			includesAllTerms("final report includes investigation outputs", ["Root cause", "Evidence", "Suggested fix", "Impact assessment"]),
		],
	},
	{
		group: "subagents",
		name: "developer",
		requiredTools: ["read", "write", "edit", "grep", "find", "ls", "bash", "contact_supervisor"],
		forbiddenTools: ["subagent", "intercom", "web_search", "fetch_content", "get_search_content", "oracle"],
		anchors: [
			heading("Operating model"),
			heading("Ambiguity and escalation"),
			heading("Validation"),
			heading("Completion report"),
			orderedTerms("developer treats ticket as source of truth", ["tk show <id>", "source of truth"]),
			orderedTerms("developer stops when the assigned ticket cannot be shown", ["tk show <id>", "fails", "report the blocker", "stop without editing files"]),
			bodyPattern("developer uses contact_supervisor for blocking decisions", /contact_supervisor/i),
			orderedTerms("developer fails closed on blocking supervisor ask failures", ["contact_supervisor", "unavailable", "fails", "times out", "report the blocker", "stop without editing files"]),
			bodyPattern(
				"developer defers validation only when the assigned ticket says otherwise",
				/run the narrowest meaningful validation before reporting completion, unless the assigned ticket explicitly says otherwise/i,
			),
			bodyPattern(
				"developer follows assigned ticket validation scope",
				/assigned ticket defines a specific validation scope.*follow the ticket instructions exactly/i,
			),
			orderedTerms("developer reports exact validation commands or explicit ticket deferral", ["Validation:", "exact commands run and outcomes", "assigned ticket explicitly deferred validation"]),
		],
	},
	{
		group: "subagents",
		name: "code-reviewer",
		requiredTools: ["read", "grep", "find", "ls", "bash", "contact_supervisor"],
		forbiddenTools: ["write", "edit", "subagent", "intercom", "web_search", "fetch_content", "get_search_content", "oracle"],
		anchors: [
			heading("Inputs"),
			heading("Review priorities"),
			heading("Escalation"),
			heading("Output rules"),
			bodyPattern("reviewer is read-only", /you are read-only/i),
			orderedTerms("review inspects vcs diff inputs", ["git diff --no-color", "git diff --cached --no-color", "git status --short --untracked-files=all"]),
			orderedTerms("ticket ids guide review", ["tk show <id>", "source of truth"]),
			bodyPattern("review output stays findings-only", /return only findings that matter/i),
		],
	},
	{
		group: "subagents",
		name: "web-scout",
		requiredTools: ["web_search", "fetch_content", "get_search_content", "read", "grep", "find", "ls", "contact_supervisor"],
		forbiddenTools: ["write", "edit", "bash", "subagent", "intercom", "oracle"],
		anchors: [
			heading("Read-only invariant"),
			heading("Citation discipline"),
			heading("Tool budget"),
			heading("Escalation"),
			heading("Output"),
			bodyPattern("web-scout stays read-only", /never write files|read-only invariant/i),
			includesAllTerms("citation contract stays intact", ["URL", "UTC retrieval timestamp", "verbatim quote"]),
			includesAllTerms("fetch budget stays concrete", ["cap of 6 HTTP fetches", "Fetch ≤ 2 top results"]),
			orderedTerms("search then fetch stop sequence", ["One `web_search` call.", "Fetch ≤ 2 top results", "At most one follow-up hop per result"]),
		],
	},
	{
		group: "subagents",
		name: "oracle",
		requiredTools: ["read", "grep", "find", "ls", "contact_supervisor", "bash"],
		forbiddenTools: ["write", "edit", "subagent", "intercom", "web_search", "fetch_content", "get_search_content", "oracle"],
		anchors: [
			heading("Inputs"),
			heading("Analysis process"),
			heading("Output"),
			bodyPattern("oracle stays read-only", /read-only|never modify files/i),
			orderedTerms("oracle gathers evidence then applies direct analysis", ["Gather", "Apply", "analysis"]),
			bodyPattern("oracle distinguishes confirmed findings from unknowns", /confirmed findings|unresolved unknowns/i),
		],
	},
	{
		group: "subagents",
		name: "contrarian",
		requiredTools: ["read", "grep", "find", "ls", "contact_supervisor", "bash"],
		forbiddenTools: ["write", "edit", "subagent", "intercom", "web_search", "fetch_content", "get_search_content", "oracle"],
		anchors: [
			heading("Inputs"),
			heading("Analysis process"),
			heading("Output"),
			bodyPattern("contrarian stays read-only", /read-only|never modify files/i),
			orderedTerms("contrarian steelmans the strongest opposing case", ["Steelman", "strongest credible opposing position"]),
			bodyPattern("contrarian separates confirmed and unresolved objections", /confirmed objections|unresolved unknowns/i),
		],
	},
];

for (const contract of contracts) {
	test(`${contract.name} prompt keeps TLH tool and workflow contracts`, () => {
		const agent = readAgentPrompt(contract.group, contract.name);
		assert.equal(agent.frontmatter.name, contract.name);
		assert.ok(agent.body.length > 0, `${contract.name} should have a prompt body`);
		assertToolContract(agent, {
			required: contract.requiredTools,
			forbidden: contract.forbiddenTools,
		});
		assertPromptAnchors(agent, contract.anchors);
	});
}

test("base architect prompt permanently includes the final-validation-ticket workflow", () => {
	const architect = readAgentPrompt("primary", "architect");
	const { normalizedBody } = architect;
	assert.match(normalizedBody, /final-validation ticket.*depends on all implementation tickets/i);
	assert.match(normalizedBody, /implementation-ticket validation narrow and ticket-scoped/i);
	assert.match(normalizedBody, /when [`']?VALIDATING\.md[`']? is present.*otherwise use repo-discovered validation commands/i);
	assert.match(normalizedBody, /make any validation deferral explicit in the ticket text/i);
});

test("base architect prompt keeps delta follow-up review guidance behind the experimental flag", () => {
	const architect = readAgentPrompt("primary", "architect");
	const { normalizedBody } = architect;
	assert.doesNotMatch(normalizedBody, /default the follow-up `code-reviewer` request to the delta since the last reviewed checkpoint/i);
	assert.doesNotMatch(normalizedBody, /prior findings.*git range or checkpoint.*changed-file list/i);
	assert.match(normalizedBody, /delegate final review to `code-reviewer` against the full vcs diff/i);
});

test("base developer prompt does not inherit the architect final-validation workflow", () => {
	const developer = readAgentPrompt("subagents", "developer");
	const { normalizedBody } = developer;
	assert.doesNotMatch(normalizedBody, /explicitly defer tests\/validation.*final validation ticket/i);
	assert.doesNotMatch(normalizedBody, /final validation ticket.*VALIDATING\.md.*otherwise.*repo-discovered commands/i);
});

test("base code-reviewer prompt keeps delta follow-up review guidance behind the experimental flag", () => {
	const reviewer = readAgentPrompt("subagents", "code-reviewer");
	const { normalizedBody } = reviewer;
	assert.doesNotMatch(normalizedBody, /follow-up review delta/i);
	assert.doesNotMatch(normalizedBody, /expect prior findings plus an exact delta baseline/i);
	assert.doesNotMatch(normalizedBody, /default to the requested delta and prior findings/i);
	assert.doesNotMatch(normalizedBody, /requested delta cannot be validated safely without wider context/i);
	assert.match(normalizedBody, /the vcs diff\./i);
});
