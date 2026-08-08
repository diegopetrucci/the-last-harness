import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const registerAnnotateGitDiff = (await jiti.import("../extensions/annotate-git-diff/index.ts")).default;

function createPiHarness() {
	return {
		commands: [],
		events: [],
		on(name, handler) {
			this.events.push({ name, handler });
		},
		registerCommand(name, config) {
			this.commands.push({ name, config });
		},
	};
}

test("annotate-git-diff registers only the renamed first-party command", () => {
	const pi = createPiHarness();
	registerAnnotateGitDiff(pi);

	assert.deepEqual(
		pi.commands.map(({ name }) => name),
		["annotate-git-diff"],
	);
	assert.equal(typeof pi.commands[0]?.config?.handler, "function");
	assert.equal(
		pi.commands.some(({ name }) => name === "diff-review"),
		false,
	);
	assert.deepEqual(
		pi.events.map(({ name }) => name),
		["session_shutdown"],
	);
});
