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
			orderedTerms("exact approved signoff gate", ["exact word", "approved"]),
			orderedTerms("developer waits for approved tickets", ["do not launch", "developer", "until", "approves", "tickets"]),
			includesAllTerms("high-risk oracle gating", ["high-stakes", "broad blast radius", "explicitly agrees"]),
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
			heading("Product workflow"),
			heading("Documentation and ticket standards"),
			bodyPattern("product never implements source changes", /do not edit source code|never implement source changes/i),
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
			orderedTerms("developer fails closed on blocking supervisor ask failures", ["contact_supervisor", "intercom", "unavailable", "fails", "times out", "report the blocker", "stop without editing files"]),
			orderedTerms("developer runs narrow validation", ["narrowest meaningful validation"]),
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
		requiredTools: ["oracle", "read", "grep", "find", "ls", "contact_supervisor", "bash"],
		forbiddenTools: ["write", "edit", "subagent", "intercom", "web_search", "fetch_content", "get_search_content"],
		anchors: [
			heading("Tool use"),
			heading("Analysis process"),
			heading("Output"),
			bodyPattern("oracle stays read-only", /read-only|never modify files/i),
			bodyPattern("oracle uses oracle tool", /use the existing [`']?oracle[`']? extension tool|use the [`']?oracle[`']? tool/i),
			orderedTerms("oracle validates tool output against local evidence", ["Ask the `oracle` tool", "Evaluate the oracle response against local evidence"]),
			includesAllTerms("oracle forbids mutating shell options", ["optional shell execution", "mutating capabilities"]),
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
