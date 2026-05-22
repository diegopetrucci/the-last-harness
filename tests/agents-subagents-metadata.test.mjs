import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url);
const { loadSubagentMetadata } = await jiti.import("../extensions/the-last-harness/prompts.ts");

function readSubagentFile(name) {
	return readFileSync(join(repoRoot, "agents", "subagents", `${name}.md`), "utf8");
}

function parseFrontmatterAll(content) {
	if (!content.startsWith("---")) {
		return {};
	}
	const end = content.indexOf("\n---", 3);
	if (end === -1) {
		return {};
	}
	const result = {};
	for (const line of content.slice(3, end).split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (match) {
			result[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
		}
	}
	return result;
}

function getBody(content) {
	if (!content.startsWith("---")) {
		return content.trim();
	}
	const end = content.indexOf("\n---", 3);
	if (end === -1) {
		return content.trim();
	}
	return content.slice(content.indexOf("\n", end + 1) + 1).trim();
}

function splitCommaList(value) {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

test("web-scout frontmatter has expected metadata fields", () => {
	const content = readSubagentFile("web-scout");
	const fm = parseFrontmatterAll(content);

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
	const content = readSubagentFile("web-scout");
	const body = getBody(content);

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
