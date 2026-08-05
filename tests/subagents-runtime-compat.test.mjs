import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test from "node:test";

import { createSubagentToolResultBridge } from "../extensions/subagents/src/extension/index.js";
import { buildPiArgs } from "../extensions/subagents/src/runs/shared/pi-args.js";
import { loadRunsForAgent } from "../extensions/subagents/src/runs/shared/run-history.js";

const repoRoot = join(import.meta.dirname, "..");

function extensionArgs(args) {
	const paths = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--extension") paths.push(args[index + 1]);
	}
	return paths;
}

test("generated child Pi arguments select generated JavaScript runtime extensions", () => {
	const result = buildPiArgs({
		baseArgs: [],
		task: "child path smoke",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
		tools: ["subagent"],
	});
	const paths = extensionArgs(result.args);

	assert.equal(paths.length, 2);
	assert.equal(paths.some((path) => path.endsWith("subagent-prompt-runtime.js")), true);
	assert.equal(paths.some((path) => path.endsWith("fanout-child.js")), true);
	assert.equal(paths.every((path) => extname(path) === ".js"), true);
});

test("Pi 0.83 tool-result bridge preserves rich failures and patches the matching execution", () => {
	const bridge = createSubagentToolResultBridge();
	const content = [{ type: "text", text: "Unknown agent with useful detail" }];
	const details = { mode: "single", results: [], diagnostic: { agent: "missing" } };
	const normalized = bridge.normalize("failure-call", "subagent", {
		content,
		details,
		isError: true,
	});

	assert.equal(Object.hasOwn(normalized, "isError"), false);
	assert.equal(normalized.content, content);
	assert.equal(normalized.details, details);
	assert.deepEqual(bridge.errorPatch("failure-call", "subagent", details), { isError: true });
	assert.equal(bridge.errorPatch("failure-call", "subagent", details), undefined);
});

test("run history ignores parsed null entries", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "tlh-subagent-run-history-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});
	writeFileSync(join(agentDir, "run-history.jsonl"), [
		"null",
		JSON.stringify({ agent: "worker", task: "ok", ts: 1, status: "ok", duration: 10 }),
		"",
	].join("\n"));

	assert.deepEqual(loadRunsForAgent("worker").map((entry) => entry.task), ["ok"]);
});

test("Pi 0.83 compatibility declaration shim is absent", () => {
	assert.equal(existsSync(join(repoRoot, "extensions/subagents/src/types/typecheck-compat.d.ts")), false);
});
