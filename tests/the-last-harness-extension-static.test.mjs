import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionSource = readFileSync(new URL("../extensions/the-last-harness.ts", import.meta.url), "utf8");

function sourceSection(startMarker, endMarker) {
	const start = extensionSource.indexOf(startMarker);
	assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
	const end = extensionSource.indexOf(endMarker, start);
	assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
	return extensionSource.slice(start, end);
}

test("before_agent_start reapplies architect defaults without a one-shot model gate", () => {
	const beforeAgentStart = sourceSection('pi.on("before_agent_start"', 'pi.on("tool_call"');
	const applyPrimaryModel = sourceSection("async function applyPrimaryModel", "function applyPrimaryThinking");
	const applyPrimaryThinking = sourceSection("function applyPrimaryThinking", "async function applyPrimaryDefaults");

	assert.doesNotMatch(extensionSource, /primaryModelAttempted/);
	assert.match(beforeAgentStart, /await applyPrimaryDefaults\(ctx\);/);
	assert.match(applyPrimaryModel, /ctx\.model\?\.provider === model\.provider && ctx\.model\?\.id === model\.id/);
	assert.match(applyPrimaryThinking, /pi\.getThinkingLevel\(\) === primaryAgent\.thinking/);
});
