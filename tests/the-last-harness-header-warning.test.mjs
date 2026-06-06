import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhHeader } = await jiti.import("../extensions/the-last-harness/header.ts");

const theme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `<bold>${text}</bold>`,
};

const plainTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function createResources() {
	return {
		context: ["AGENTS.md"],
		skills: ["tlh-dev-hygiene"],
		prompts: ["ship-it"],
		extensions: ["the-last-harness"],
		themes: ["the-last-harness"],
	};
}

function createEmptyResources() {
	return {
		context: [],
		skills: [],
		prompts: [],
		extensions: [],
		themes: [],
	};
}

test("collapsed header renders the install-track warning above Context and includes the resource toggle hint", () => {
	const header = createTlhHeader(theme, createResources(), undefined, {
		kind: "ref",
		summary: "TLH follows a non-stable git ref.",
		detail: "main",
	});

	assert.deepEqual(header.render(200), [
		"<bold><accent>tlh</accent></bold>",
		"",
		"<warning>Warning</warning><dim>: running TLH from main track</dim>",
		"<dim>Context: AGENTS.md</dim>",
		"<dim>Ctrl+Shift+E to show skills, prompts, extensions, themes</dim>",
	]);
});

test("collapsed header renders the startup tip as the final header line with a lightly highlighted label", () => {
	const header = createTlhHeader(theme, createResources(), undefined, undefined, {
		startupTip: "Use /switch-primary-agent to pick architect, rush, product, bug-hunter, or disabled for this session.",
	});

	assert.deepEqual(header.render(200), [
		"<bold><accent>tlh</accent></bold>",
		"",
		"<dim>Context: AGENTS.md</dim>",
		"<dim>Ctrl+Shift+E to show skills, prompts, extensions, themes</dim>",
		"<muted>Tip</muted><dim>: Use /switch-primary-agent to pick architect, rush, product, bug-hunter, or disabled for this session.</dim>",
	]);
});

test("expanded header keeps the install-track warning above Context, then resource sections, then the startup tip", () => {
	const header = createTlhHeader(theme, createResources(), undefined, {
		kind: "custom-package-source",
		summary: "TLH uses a custom package source.",
		detail: "../the-last-harness",
	}, {
		startupTip: "Use /usage to check TLH usage status or toggle the weekly usage window.",
	});
	header.setExpanded(true);

	assert.deepEqual(header.render(200), [
		"<bold><accent>tlh</accent></bold>",
		"",
		"<warning>Warning</warning><dim>: running TLH from local track</dim>",
		"<dim>Context: AGENTS.md</dim>",
		"",
		"<mdHeading>[Skills]</mdHeading>",
		"<dim>  tlh-dev-hygiene</dim>",
		"",
		"<mdHeading>[Prompts]</mdHeading>",
		"<dim>  ship-it</dim>",
		"",
		"<mdHeading>[Extensions]</mdHeading>",
		"<dim>  the-last-harness</dim>",
		"",
		"<mdHeading>[Themes]</mdHeading>",
		"<dim>  the-last-harness</dim>",
		"",
		"<muted>Tip</muted><dim>: Use /usage to check TLH usage status or toggle the weekly usage window.</dim>",
	]);
});

test("startup tips wrap without truncation and stay last in collapsed and expanded headers", () => {
	const startupTip = "Use /fork to branch from an earlier user message and explore an alternate path.";
	const expectedTipBlock = [
		"Tip: Use /fork to branch",
		"     from an earlier user",
		"     message and explore",
		"     an alternate path.",
	];
	const collapsedHeader = createTlhHeader(plainTheme, createEmptyResources(), undefined, undefined, { startupTip });
	const expandedHeader = createTlhHeader(plainTheme, createEmptyResources(), undefined, undefined, { startupTip });
	expandedHeader.setExpanded(true);

	const collapsedLines = collapsedHeader.render(25);
	const expandedLines = expandedHeader.render(25);
	const collapsedTipBlock = collapsedLines.slice(-expectedTipBlock.length);
	const expandedTipBlock = expandedLines.slice(-expectedTipBlock.length);

	assert.deepEqual(collapsedTipBlock, expectedTipBlock);
	assert.deepEqual(expandedTipBlock, expectedTipBlock);
	assert.match(collapsedLines.at(-expectedTipBlock.length - 1) ?? "", /^Ctrl\+Shift\+E/u);
	assert.equal(expandedLines.at(-expectedTipBlock.length - 1), "");
	assert.equal(collapsedTipBlock.some((line) => line.includes("...")), false);
	assert.equal(expandedTipBlock.some((line) => line.includes("...")), false);
	assert.equal(collapsedTipBlock.every((line) => visibleWidth(line) <= 25), true);
	assert.equal(expandedTipBlock.every((line) => visibleWidth(line) <= 25), true);
});
