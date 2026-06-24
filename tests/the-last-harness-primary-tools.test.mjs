import assert from "node:assert/strict";
import test from "node:test";

import { createPrimaryToolState, filterAvailableTools } from "../extensions/the-last-harness-primary-tools.mjs";

test("disabled primary mode restores active tools from before primary tools were applied", () => {
	const availableTools = new Set(["bash", "edit", "find", "grep", "read"]);
	const primaryToolState = createPrimaryToolState();
	let activeTools = ["bash", "edit"];

	function applyPrimaryTools(desiredTools) {
		const validTools = filterAvailableTools(desiredTools, availableTools);
		if (validTools.length === 0) {
			return;
		}
		activeTools = primaryToolState.apply(validTools, activeTools);
	}

	function disablePrimaryTools() {
		const restoredTools = primaryToolState.restoreIfAppropriate(activeTools, availableTools);
		if (restoredTools) {
			activeTools = restoredTools;
		}
	}

	applyPrimaryTools(["read", "grep"]);
	assert.deepEqual(activeTools, ["read", "grep"]);

	applyPrimaryTools(["read", "find"]);
	assert.deepEqual(activeTools, ["read", "find"]);

	disablePrimaryTools();
	assert.deepEqual(activeTools, ["bash", "edit"]);
});

test("disabled primary mode does not overwrite active tools changed after primary application", () => {
	const availableTools = new Set(["bash", "edit", "grep", "read"]);
	const primaryToolState = createPrimaryToolState();
	let activeTools = ["bash", "edit"];

	primaryToolState.apply(["read", "grep"], activeTools);
	activeTools = ["bash"];

	const restoredTools = primaryToolState.restoreIfAppropriate(activeTools, availableTools);
	if (restoredTools) {
		activeTools = restoredTools;
	}

	assert.deepEqual(activeTools, ["bash"]);
});
