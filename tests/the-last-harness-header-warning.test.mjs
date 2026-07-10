import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhHeader } = await jiti.import("../extensions/the-last-harness/header.ts");

const plainTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function createEmptyResources() {
	return {
		context: [],
		skills: [],
		prompts: [],
		extensions: [],
		themes: [],
	};
}


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
	const collapsedNonTipLines = collapsedLines.slice(0, -expectedTipBlock.length);
	assert.ok(
		collapsedNonTipLines.some((line) => /^Press Ctrl\+Shift\+E/u.test(line)),
		"collapsed header should contain the standalone Ctrl+Shift+E hint",
	);
	assert.equal(expandedLines.at(-expectedTipBlock.length - 1), "");
	assert.equal(collapsedTipBlock.some((line) => line.includes("...")), false);
	assert.equal(expandedTipBlock.some((line) => line.includes("...")), false);
	assert.equal(collapsedTipBlock.every((line) => visibleWidth(line) <= 25), true);
	assert.equal(expandedTipBlock.every((line) => visibleWidth(line) <= 25), true);
});
