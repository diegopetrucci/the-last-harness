import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";

let tempDir = "";
let oldAgentDir: string | undefined;

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	if (typeof first.text !== "string") throw new Error("Expected text content to be a string");
	return first.text;
}

describe("agent management config parsing", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-management-"));
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
		clearSkillCache();
	});

	afterEach(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects saved-chain get and leaves JSON chain files untouched while list stays agent-only", () => {
		const ctx = { cwd: tempDir };
		const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		const original = JSON.stringify(
			{
				name: "dynamic-review",
				description: "Review dynamic targets",
				chain: [{ agent: "scout", task: "Return targets" }],
			},
			null,
			2,
		);
		fs.writeFileSync(chainPath, original, "utf-8");
		fs.writeFileSync(path.join(tempDir, ".pi", "chains", "broken.chain.json"), "{", "utf-8");

		const got = handleManagementAction("get", { chainName: "dynamic-review" }, ctx);
		assert.equal(got.isError, true);
		assert.match(readText(got), /Saved chains are deliberately unsupported in The Last Harness/);
		assert.equal(fs.readFileSync(chainPath, "utf-8"), original);

		const listed = handleManagementAction("list", {}, ctx);
		const text = readText(listed);
		assert.equal(listed.isError, false);
		assert.match(text, /^Executable agents:/);
		assert.doesNotMatch(text, /\bChains:\b/);
		assert.doesNotMatch(text, /Chain diagnostics:/);
		assert.doesNotMatch(text, /broken\.chain\.json/);
		assert.doesNotMatch(text, /Invalid JSON chain/);
	});

	it("rejects the models action as unknown and returns an error", () => {
		const result = handleManagementAction("models", {}, { cwd: tempDir });
		assert.equal(result.isError, true);
		assert.match(readText(result), /Unknown action: models/);
	});

	it("discovers no builtin agents from a clean environment", () => {
		const discovered = discoverAgentsAll(tempDir);
		assert.deepEqual(discovered.builtin, [], "builtin agents must be empty after removal");
	});
});
