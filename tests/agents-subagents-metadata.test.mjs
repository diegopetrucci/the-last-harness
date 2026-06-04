import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

import { readAgentPrompt, splitCommaList } from "./agent-prompt-test-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { loadSubagentMetadata } = await jiti.import("../extensions/the-last-harness/prompts.ts");

test("web-scout frontmatter has expected metadata fields", () => {
	const { frontmatter: fm } = readAgentPrompt("subagents", "web-scout");

	assert.equal(fm.name, "web-scout");
	assert.equal(fm.description, "Performs Exa-backed web research and URL fetch in an isolated read-only context.");
	assert.deepEqual(
		splitCommaList(fm.tools),
		["web_search", "fetch_content", "get_search_content", "read", "grep", "find", "ls", "contact_supervisor"],
	);
	assert.equal(fm.model, "anthropic/claude-haiku-4-5");
	assert.deepEqual(splitCommaList(fm.tlhOpenaiModels), ["openai-codex/gpt-5.4-mini", "openai/gpt-5.4-mini"]);
	assert.equal(fm.thinking, "high");
	assert.equal(fm.systemPromptMode, "replace");
	assert.equal(fm.inheritProjectContext, "true");
	assert.equal(fm.inheritSkills, "false");
	assert.equal(fm.defaultContext, "fresh");
});

test("web-scout body contains all mandatory guardrail keywords", () => {
	const { body } = readAgentPrompt("subagents", "web-scout");

	const guardrails = [
		["read-only invariant", /read-only invariant/i],
		["untrusted", /untrusted/i],
		["citation", /citation/i],
		["fabrication", /fabrication/i],
		["http(s)-only", /https?/i],
		["secret", /secret/i],
		["budget", /budget/i],
		["escalation", /escalation/i],
	];
	for (const [keyword, pattern] of guardrails) {
		assert.match(body, pattern, `body should contain mandatory guardrail keyword: ${keyword}`);
	}
});

test("web-scout tool budget uses a concrete fetch limit with no placeholder text", () => {
	const { body } = readAgentPrompt("subagents", "web-scout");

	assert.match(body, /per-turn cap of 6 HTTP fetches/i);
	assert.match(body, /Fetch ≤ 2 top results/);
	assert.doesNotMatch(body, /Fetch ≤ N top results/);
});

test("validator frontmatter has expected metadata fields", () => {
	const { frontmatter: fm } = readAgentPrompt("subagents", "validator");

	assert.equal(fm.name, "validator");
	assert.equal(fm.description, "Runs source-read-only validation commands and reports exact outcomes.");
	assert.deepEqual(splitCommaList(fm.tools), ["read", "grep", "find", "ls", "bash", "contact_supervisor"]);
	assert.equal(fm.model, "anthropic/claude-haiku-4-5");
	assert.deepEqual(splitCommaList(fm.tlhOpenaiModels), ["openai-codex/gpt-5.4-mini", "openai/gpt-5.4-mini"]);
	assert.equal(fm.thinking, "high");
	assert.equal(fm.systemPromptMode, "replace");
	assert.equal(fm.inheritProjectContext, "true");
	assert.equal(fm.inheritSkills, "false");
	assert.equal(fm.defaultContext, "fresh");
});

test("validator body contains mandatory validation guardrails", () => {
	const { body } = readAgentPrompt("subagents", "validator");

	const guardrails = [
		["VALIDATING.md first", /VALIDATING\.md[\s\S]*read it first/i],
		["source-read-only", /source-read-only/i],
		["autofix", /autofix/i],
		["snapshots", /snapshot/i],
		["installs", /install dependenc/i],
		["watchers", /watchers?|watch mode/i],
		["network approval", /network(?:-dependent)? commands?|network access/i],
		["git status before/after", /git status before validation/i],
		["failure triage", /failure triage/i],
	];
	for (const [keyword, pattern] of guardrails) {
		assert.match(body, pattern, `body should contain mandatory validator guardrail keyword: ${keyword}`);
	}
});

test("loadSubagentMetadata exposes validator with expected model, tlhOpenaiModels, and description", () => {
	const subagents = loadSubagentMetadata();
	const validator = subagents.find((agent) => agent.name === "validator");

	assert.ok(validator, "validator should be present in loadSubagentMetadata()");
	assert.equal(validator.model, "anthropic/claude-haiku-4-5");
	assert.deepEqual(validator.tlhOpenaiModels, ["openai-codex/gpt-5.4-mini", "openai/gpt-5.4-mini"]);
	assert.equal(validator.description, "Runs source-read-only validation commands and reports exact outcomes.");
});

test("loadSubagentMetadata exposes web-scout with expected model, tlhOpenaiModels, and description", () => {
	const subagents = loadSubagentMetadata();
	const webScout = subagents.find((agent) => agent.name === "web-scout");

	assert.ok(webScout, "web-scout should be present in loadSubagentMetadata()");
	assert.equal(webScout.model, "anthropic/claude-haiku-4-5");
	assert.deepEqual(webScout.tlhOpenaiModels, ["openai-codex/gpt-5.4-mini", "openai/gpt-5.4-mini"]);
	assert.equal(
		webScout.description,
		"Performs Exa-backed web research and URL fetch in an isolated read-only context.",
	);
});
