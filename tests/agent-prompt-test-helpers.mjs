import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function parseFrontmatter(content) {
	if (!content.startsWith("---")) {
		return { frontmatter: {}, body: content.trim() };
	}
	const end = content.indexOf("\n---", 3);
	if (end === -1) {
		return { frontmatter: {}, body: content.trim() };
	}

	const frontmatter = {};
	for (const line of content.slice(3, end).split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) {
			continue;
		}
		frontmatter[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
	}

	return {
		frontmatter,
		body: content.slice(content.indexOf("\n", end + 1) + 1).trim(),
	};
}

export function splitCommaList(value) {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeWhitespace(text) {
	return text.replace(/\s+/g, " ").trim();
}

export function readAgentPrompt(group, name) {
	const path = join(repoRoot, "agents", group, `${name}.md`);
	const content = readFileSync(path, "utf8");
	const { frontmatter, body } = parseFrontmatter(content);
	return {
		path,
		content,
		frontmatter,
		body,
		normalizedBody: normalizeWhitespace(body),
		tools: splitCommaList(frontmatter.tools),
	};
}

export function assertToolContract(agent, { required = [], forbidden = [] }) {
	const tools = new Set(agent.tools);
	for (const tool of required) {
		assert.ok(tools.has(tool), `${agent.frontmatter.name} should include tool ${tool}`);
	}
	for (const tool of forbidden) {
		assert.ok(!tools.has(tool), `${agent.frontmatter.name} should not include tool ${tool}`);
	}
}

function escapeRegex(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function heading(title) {
	return {
		label: `heading ${title}`,
		test: (agent) => new RegExp(`^##\\s+${escapeRegex(title)}\\b`, "im").test(agent.body),
	};
}

export function orderedTerms(label, terms) {
	const pattern = new RegExp(terms.map((term) => escapeRegex(term)).join(".*?"), "i");
	return {
		label,
		test: (agent) => pattern.test(agent.normalizedBody),
	};
}

export function includesAllTerms(label, terms) {
	const patterns = terms.map((term) => new RegExp(escapeRegex(term), "i"));
	return {
		label,
		test: (agent) => patterns.every((pattern) => pattern.test(agent.normalizedBody)),
	};
}

export function bodyPattern(label, pattern) {
	return {
		label,
		test: (agent) => pattern.test(agent.normalizedBody),
	};
}

export function assertPromptAnchors(agent, anchors) {
	for (const anchor of anchors) {
		assert.ok(anchor.test(agent), `${agent.frontmatter.name} should keep semantic anchor: ${anchor.label}`);
	}
}
