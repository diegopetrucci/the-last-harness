import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhHeader, formatTlhLaunchContextAllocation } = await jiti.import(
	"../extensions/the-last-harness/header.ts",
);
const { estimateTlhLaunchContextAllocation } = await jiti.import("../extensions/the-last-harness/launch-context.ts");

const plainTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function estimateTokens(chars) {
	return chars > 0 ? Math.ceil(chars / 4) : 0;
}

function escapeXml(value) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function createAllocation() {
	return {
		contextWindow: 10_000,
		estimatedTokens: {
			tlh: 0,
			agentsClaude: 1,
			skills: 99,
			tools: 100,
			other: 155,
		},
	};
}

test("launch allocation attributes base runtime instructions to TLH and carves out prompt metadata", () => {
	const contextFile = {
		path: "/repo/AGENTS.md",
		content: "Repository <instructions> & conventions",
	};
	const skill = {
		name: "deploy&ship",
		description: "Use <deploy> safely",
		filePath: "/repo/.pi/skills/deploy&ship/SKILL.md",
	};
	const guideline = "Keep edits focused";
	const baseSystemPrompt = [
		"Pi startup overhead",
		contextFile.path,
		contextFile.content,
		escapeXml(skill.name),
		escapeXml(skill.description),
		escapeXml(skill.filePath),
		guideline,
		"Remaining prompt framing",
	].join("\n");
	const tlhAddition = "\n\nTLH and active-primary instructions";
	const readTool = {
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
		promptGuidelines: [guideline, guideline],
	};
	const inactiveTool = {
		name: "inactive",
		description: "This inactive definition must not be attributed",
		parameters: { type: "object", properties: { payload: { type: "string" } } },
	};
	const serializedTools = JSON.stringify([
		{ name: readTool.name, description: readTool.description, parameters: readTool.parameters },
	]);
	const agentsClaudeChars = contextFile.path.length + contextFile.content.length;
	const skillChars =
		escapeXml(skill.name).length + escapeXml(skill.description).length + escapeXml(skill.filePath).length;
	const baseInstructionChars = baseSystemPrompt.length - agentsClaudeChars - skillChars - guideline.length;

	const allocation = estimateTlhLaunchContextAllocation({
		contextWindow: 200_000,
		baseSystemPrompt,
		launchSystemPrompt: `${baseSystemPrompt}${tlhAddition}`,
		promptMetadata: { contextFiles: [contextFile], skills: [skill] },
		activeToolNames: ["read"],
		allTools: [readTool, inactiveTool],
	});

	assert.deepEqual(allocation, {
		contextWindow: 200_000,
		estimatedTokens: {
			tlh: estimateTokens(baseInstructionChars + tlhAddition.length),
			agentsClaude: estimateTokens(agentsClaudeChars),
			skills: estimateTokens(skillChars),
			tools: estimateTokens(guideline.length + serializedTools.length),
			other: 0,
		},
	});
});

test("launch allocation requires a context window and excludes skill metadata without the read tool", () => {
	const options = {
		contextWindow: 100_000,
		baseSystemPrompt: "skill-name",
		launchSystemPrompt: "skill-name\n\nTLH",
		promptMetadata: {
			contextFiles: [],
			skills: [{ name: "skill-name", description: "description", filePath: "/skill/SKILL.md" }],
		},
		activeToolNames: [],
		allTools: [],
	};

	assert.equal(estimateTlhLaunchContextAllocation(options)?.estimatedTokens.skills, 0);
	assert.equal(estimateTlhLaunchContextAllocation({ ...options, contextWindow: undefined }), undefined);
});

test("launch allocation formatting preserves category order and distinguishes zero and sub-one percent", () => {
	assert.equal(
		formatTlhLaunchContextAllocation(createAllocation()),
		"Context at launch: TLH 0% • AGENTS/CLAUDE.md <1% • Skills <1% • Tools ~1% • Other ~2%",
	);
});

test("collapsed launch allocation hides resource names while expanded mode preserves the inventory", () => {
	const resources = {
		context: ["team-rules.md"],
		skills: ["deploy"],
		prompts: ["/review"],
		extensions: ["tools.js"],
		themes: ["night"],
	};
	const installNotice = { kind: "ref", summary: "non-stable ref", detail: "main" };
	const header = createTlhHeader(plainTheme, resources, undefined, installNotice, {
		launchContextAllocation: createAllocation(),
	});

	const collapsed = header.render(200);
	assert.ok(collapsed.includes(formatTlhLaunchContextAllocation(createAllocation())));
	assert.equal(
		collapsed.some((line) => line.includes("team-rules.md")),
		false,
	);
	assert.equal(
		collapsed.some((line) => line.includes("deploy")),
		false,
	);

	header.setExpanded(true);
	const expanded = header.render(200);
	const warningIndex = expanded.findIndex((line) => line.includes("running TLH from main track"));
	const allocationIndex = expanded.indexOf(formatTlhLaunchContextAllocation(createAllocation()));
	const contextIndex = expanded.indexOf("Context: team-rules.md");
	assert.equal(expanded.filter((line) => line.includes("running TLH from main track")).length, 1);
	assert.equal(allocationIndex, warningIndex + 1);
	assert.equal(contextIndex, allocationIndex + 1);
	for (const section of ["[Skills]", "[Prompts]", "[Extensions]", "[Themes]"]) {
		assert.ok(expanded.includes(section), `expected expanded inventory section ${section}`);
	}
});

test("collapsed launch allocation wraps within narrow terminal widths", () => {
	const header = createTlhHeader(
		plainTheme,
		{ context: [], skills: [], prompts: [], extensions: [], themes: [] },
		undefined,
		undefined,
		{ launchContextAllocation: createAllocation() },
	);
	const width = 28;
	const lines = header.render(width);

	assert.ok(lines.some((line) => line.startsWith("Context at launch:")));
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line exceeded width ${width}: ${JSON.stringify(line)}`);
	}
});
