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
	assert.deepEqual(splitCommaList(fm.tlhOpenaiModels), ["openai-codex/gpt-5.4-mini"]);
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

test("loadSubagentMetadata exposes web-scout with expected model, tlhOpenaiModels, and description", () => {
	const subagents = loadSubagentMetadata();
	const webScout = subagents.find((agent) => agent.name === "web-scout");

	assert.ok(webScout, "web-scout should be present in loadSubagentMetadata()");
	assert.equal(webScout.model, "anthropic/claude-haiku-4-5");
	assert.deepEqual(webScout.tlhOpenaiModels, ["openai-codex/gpt-5.4-mini"]);
	assert.ok("preferOppositeProvider" in webScout);
	assert.equal(webScout.preferOppositeProvider, undefined);
	assert.equal(
		webScout.description,
		"Performs Exa-backed web research and URL fetch in an isolated read-only context.",
	);
});

test("code-reviewer metadata prefers the opposite provider without an authoritative default model", () => {
	const { frontmatter: fm } = readAgentPrompt("subagents", "code-reviewer");
	const subagents = loadSubagentMetadata();
	const codeReviewer = subagents.find((agent) => agent.name === "code-reviewer");

	assert.equal(fm.model, undefined);
	assert.equal(fm.preferOppositeProvider, "true");
	assert.deepEqual(splitCommaList(fm.tlhOpenaiModels), ["openai-codex/gpt-5.5"]);
	assert.deepEqual(splitCommaList(fm.tlhAnthropicModels), ["anthropic/claude-opus-4-8"]);

	assert.ok(codeReviewer, "code-reviewer should be present in loadSubagentMetadata()");
	assert.equal(codeReviewer.model, undefined);
	assert.deepEqual(codeReviewer.tlhOpenaiModels, ["openai-codex/gpt-5.5"]);
	assert.deepEqual(codeReviewer.tlhAnthropicModels, ["anthropic/claude-opus-4-8"]);
	assert.equal(codeReviewer.preferOppositeProvider, true);
});

test("contrarian metadata prefers the opposite provider without an authoritative default model", () => {
	const { frontmatter: fm } = readAgentPrompt("subagents", "contrarian");
	const subagents = loadSubagentMetadata();
	const contrarian = subagents.find((agent) => agent.name === "contrarian");

	assert.equal(fm.model, undefined);
	assert.equal(fm.preferOppositeProvider, "true");
	assert.equal(fm.defaultContext, "fresh");
	assert.deepEqual(splitCommaList(fm.tlhOpenaiModels), ["openai-codex/gpt-5.5"]);
	assert.deepEqual(splitCommaList(fm.tlhAnthropicModels), ["anthropic/claude-opus-4-8"]);

	assert.ok(contrarian, "contrarian should be present in loadSubagentMetadata()");
	assert.equal(contrarian.model, undefined);
	assert.equal(
		contrarian.description,
		"Stress-tests plans, designs, and conclusions by steelmanning the strongest opposing case.",
	);
	assert.deepEqual(contrarian.tlhOpenaiModels, ["openai-codex/gpt-5.5"]);
	assert.deepEqual(contrarian.tlhAnthropicModels, ["anthropic/claude-opus-4-8"]);
	assert.equal(contrarian.preferOppositeProvider, true);
});
