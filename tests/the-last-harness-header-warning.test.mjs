import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhHeader } = await jiti.import("../extensions/the-last-harness/header.ts");

const theme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `<bold>${text}</bold>`,
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

test("collapsed header renders the startup tip as a single dim line above the resource toggle hint", () => {
	const header = createTlhHeader(theme, createResources(), undefined, undefined, {
		startupTip: "Use /switch-primary-agent to pick architect, rush, product, bug-hunter, or disabled for this session.",
	});

	assert.deepEqual(header.render(200), [
		"<bold><accent>tlh</accent></bold>",
		"",
		"<dim>Context: AGENTS.md</dim>",
		"<dim>Tip: Use /switch-primary-agent to pick architect, rush, product, bug-hunter, or disabled for this session.</dim>",
		"<dim>Ctrl+Shift+E to show skills, prompts, extensions, themes</dim>",
	]);
});

test("expanded header keeps the install-track warning above Context before resource sections", () => {
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
		"<dim>Tip: Use /usage to check TLH usage status or toggle the weekly usage window.</dim>",
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
	]);
});
