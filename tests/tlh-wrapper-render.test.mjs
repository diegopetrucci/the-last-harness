/**
 * Unit tests for the renderWrapper function in scripts/tlh-wrapper.mjs.
 * These tests check the rendered shell-script string directly, without
 * executing the wrapper.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderWrapper } from "../scripts/tlh-wrapper.mjs";

// Minimal valid args used across multiple tests.
const BASE_ARGS = {
	agentDir: "/tmp/test-agent",
	binDir: "/tmp/test-bin",
	wrapperName: "tlh",
	packageRoot: "/tmp/test-package",
};

const PINNED_ARGS = {
	...BASE_ARGS,
	piCmd: "/home/user/.the-last-harness/runtime/bin/pi",
};

test("renderWrapper: NODE_COMPILE_CACHE export is present exactly once in the pi exec path", () => {
	const rendered = renderWrapper(PINNED_ARGS);
	const lines = rendered.split("\n");

	const compileCacheLines = lines.filter((line) => line.includes("NODE_COMPILE_CACHE"));
	assert.equal(
		compileCacheLines.length,
		1,
		`expected exactly one NODE_COMPILE_CACHE line; got: ${JSON.stringify(compileCacheLines)}`,
	);
	assert.equal(
		compileCacheLines[0],
		'export NODE_COMPILE_CACHE="${tlh_pinned_dir%/*}/node-compile-cache"',
	);
});

test("renderWrapper: NODE_COMPILE_CACHE export appears immediately before exec of pinned pi", () => {
	const rendered = renderWrapper(PINNED_ARGS);
	const lines = rendered.split("\n");

	const ncIndex = lines.indexOf('export NODE_COMPILE_CACHE="${tlh_pinned_dir%/*}/node-compile-cache"');
	const execIndex = lines.indexOf('exec "${default_pi_cmd}" "$@"');

	assert.ok(ncIndex >= 0, "NODE_COMPILE_CACHE export line must be present");
	assert.ok(execIndex >= 0, 'exec "${default_pi_cmd}" "$@" line must be present');
	assert.equal(
		ncIndex + 1,
		execIndex,
		"NODE_COMPILE_CACHE export must be the line immediately before the pi exec",
	);
});

test("renderWrapper: helper branch exec lines do not include NODE_COMPILE_CACHE", () => {
	const rendered = renderWrapper(PINNED_ARGS);
	const lines = rendered.split("\n");

	// Helper branches use 'exec "${tlh_node_cmd}"' to run Node helper scripts.
	// NODE_COMPILE_CACHE must not appear on those lines.
	const helperExecLines = lines.filter((line) => line.includes('exec "${tlh_node_cmd}"'));
	assert.ok(helperExecLines.length > 0, "at least one helper exec line must exist");
	for (const line of helperExecLines) {
		assert.ok(
			!line.includes("NODE_COMPILE_CACHE"),
			`helper exec line must not include NODE_COMPILE_CACHE: ${line}`,
		);
	}
});

test("renderWrapper: NODE_COMPILE_CACHE export uses tlh_pinned_dir%/* (strip bin dir → runtime prefix)", () => {
	// With piCmd="/a/runtime/bin/pi":
	//   tlh_pinned_dir="${default_pi_cmd%/*}"  → "/a/runtime/bin"
	//   ${tlh_pinned_dir%/*}                   → "/a/runtime"
	//   NODE_COMPILE_CACHE                     → "/a/runtime/node-compile-cache"
	// The shell expression must be verbatim so it evaluates correctly at runtime.
	const rendered = renderWrapper({
		...BASE_ARGS,
		piCmd: "/a/runtime/bin/pi",
	});
	assert.ok(
		rendered.includes('export NODE_COMPILE_CACHE="${tlh_pinned_dir%/*}/node-compile-cache"'),
		"rendered wrapper must contain the verbatim NODE_COMPILE_CACHE export expression",
	);
});
