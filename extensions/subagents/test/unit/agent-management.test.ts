import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCreate, handleManagementAction, handleUpdate } from "../../src/agents/agent-management.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";

let tempDir = "";
let oldAgentDir: string | undefined;

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	assert.equal(typeof first.text, "string");
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

	it("surfaces JSON parse errors for create config strings", () => {
		const result = handleCreate(
			{ config: '{"name":' },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config must be valid JSON:/);
	});

	it("surfaces JSON parse errors for update config strings", () => {
		const result = handleUpdate(
			{ agent: "reviewer", config: '{"description":' },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config must be valid JSON:/);
	});

	it("creates, gets, updates, and deletes a packaged agent by runtime name", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "Scout", package: "Code Analysis", description: "Fast recon", scope: "project", systemPrompt: "Inspect" } },
			ctx,
		);

		assert.equal(created.isError, false);
		assert.match(readText(created), /Created agent 'code-analysis.scout'/);
		const filePath = path.join(tempDir, ".pi", "agents", "code-analysis.scout.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^name: scout$/m);
		assert.match(content, /^package: code-analysis$/m);
		assert.doesNotMatch(content, /^name: code-analysis\.scout$/m);

		const got = handleManagementAction("get", { agent: "code-analysis.scout" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Agent: code-analysis\.scout/);
		assert.match(readText(got), /Local name: scout/);
		assert.match(readText(got), /Package: code-analysis/);

		const updated = handleUpdate(
			{ agent: "code-analysis.scout", config: { package: "documentation" } },
			ctx,
		);
		assert.equal(updated.isError, false);
		assert.match(readText(updated), /code-analysis\.scout' to 'documentation\.scout'/);
		assert.equal(fs.existsSync(filePath), false);
		const updatedPath = path.join(tempDir, ".pi", "agents", "documentation.scout.md");
		content = fs.readFileSync(updatedPath, "utf-8");
		assert.match(content, /^name: scout$/m);
		assert.match(content, /^package: documentation$/m);

		const deleted = handleManagementAction("delete", { agent: "documentation.scout" }, ctx);
		assert.equal(deleted.isError, false);
		assert.equal(fs.existsSync(updatedPath), false);
	});

	it("rejects package values that cannot be normalized", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "Scout", package: "!!!", description: "Fast recon", scope: "project" } },
			ctx,
		);

		assert.equal(created.isError, true);
		assert.match(readText(created), /config\.package is invalid/);
	});

	it("rejects saved-chain create and update inputs without touching existing chain files", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const chainPath = path.join(tempDir, ".pi", "chains", "code-analysis.review-flow.chain.md");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		const original = `---\nname: review-flow\npackage: code-analysis\ndescription: Review flow\n---\n\n## code-analysis.scout\n\nInspect\n`;
		fs.writeFileSync(chainPath, original, "utf-8");

		const created = handleCreate(
			{ config: { name: "Review Flow", package: "Code Analysis", description: "Review flow", scope: "project", steps: [{ agent: "code-analysis.scout", task: "Inspect" }] } },
			ctx,
		);
		assert.equal(created.isError, true);
		assert.match(readText(created), /Saved chains are deliberately unsupported in The Last Harness/);
		assert.equal(fs.readFileSync(chainPath, "utf-8"), original);

		const updated = handleUpdate({ chainName: "code-analysis.review-flow", config: { package: false } }, ctx);
		assert.equal(updated.isError, true);
		assert.match(readText(updated), /Saved chains are deliberately unsupported in The Last Harness/);
		assert.equal(fs.readFileSync(chainPath, "utf-8"), original);
	});

	it("creates and updates agents with tool budgets", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const result = handleCreate(
			{ config: { name: "budgeted-reviewer", description: "Review with a budget", scope: "project", toolBudget: { soft: 4, hard: 7, block: ["read", "grep"] } } },
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "budgeted-reviewer.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^toolBudget: \{"soft":4,"hard":7,"block":\["read","grep"\]\}$/m);

		const got = handleManagementAction("get", { agent: "budgeted-reviewer" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Tool budget: \{"soft":4,"hard":7,"block":\["read","grep"\]\}/);

		const updated = handleUpdate(
			{ agent: "budgeted-reviewer", config: { toolBudget: { hard: 3, block: "*" } } },
			ctx,
		);
		assert.equal(updated.isError, false);
		content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^toolBudget: \{"hard":3,"block":"\*"\}$/m);
	});

	it("rejects invalid tool budget management config", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const agentResult = handleCreate(
			{ config: { name: "bad-budget", description: "Bad budget", scope: "project", toolBudget: { soft: 5, hard: 4 } } },
			ctx,
		);
		assert.equal(agentResult.isError, true);
		assert.match(readText(agentResult), /config\.toolBudget\.soft must be <= config\.toolBudget\.hard/);

		const chainResult = handleCreate(
			{ config: { name: "bad-chain-budget", description: "Bad budget", scope: "project", steps: [{ agent: "reviewer", toolBudget: { hard: 2, block: [] } }] } },
			ctx,
		);
		assert.equal(chainResult.isError, true);
		assert.match(readText(chainResult), /Saved chains are deliberately unsupported in The Last Harness/);
	});

	it("creates, updates, reports, clears, and validates acceptance roles", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "explorer", description: "Explore code", scope: "project", acceptanceRole: "read-only" } },
			ctx,
		);
		assert.equal(created.isError, false);

		const filePath = path.join(tempDir, ".pi", "agents", "explorer.md");
		assert.match(fs.readFileSync(filePath, "utf-8"), /^acceptanceRole: read-only$/m);
		assert.match(readText(handleManagementAction("get", { agent: "explorer" }, ctx)), /Acceptance role: read-only/);

		const updated = handleUpdate({ agent: "explorer", config: { acceptanceRole: "writer" } }, ctx);
		assert.equal(updated.isError, false);
		assert.match(fs.readFileSync(filePath, "utf-8"), /^acceptanceRole: writer$/m);

		const cleared = handleUpdate({ agent: "explorer", config: { acceptanceRole: false } }, ctx);
		assert.equal(cleared.isError, false);
		assert.doesNotMatch(fs.readFileSync(filePath, "utf-8"), /^acceptanceRole:/m);

		assert.equal(handleUpdate({ agent: "explorer", config: { acceptanceRole: "read-only" } }, ctx).isError, false);
		assert.equal(handleUpdate({ agent: "explorer", config: { acceptanceRole: "" } }, ctx).isError, false);
		assert.doesNotMatch(fs.readFileSync(filePath, "utf-8"), /^acceptanceRole:/m);

		const invalid = handleUpdate({ agent: "explorer", config: { acceptanceRole: "observer" } }, ctx);
		assert.equal(invalid.isError, true);
		assert.match(readText(invalid), /config\.acceptanceRole must be 'read-only', 'writer', or false/);
	});

	it("creates, updates, reports, clears, and validates max execution time ceilings", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "explorer", description: "Explore code", scope: "project", maxExecutionTimeMs: 1500 } },
			ctx,
		);
		assert.equal(created.isError, false);

		const filePath = path.join(tempDir, ".pi", "agents", "explorer.md");
		assert.match(fs.readFileSync(filePath, "utf-8"), /^maxExecutionTimeMs: 1500$/m);
		assert.match(readText(handleManagementAction("get", { agent: "explorer" }, ctx)), /Max execution time: 1500ms/);

		const updated = handleUpdate({ agent: "explorer", config: { maxExecutionTimeMs: 900 } }, ctx);
		assert.equal(updated.isError, false);
		assert.match(fs.readFileSync(filePath, "utf-8"), /^maxExecutionTimeMs: 900$/m);

		const cleared = handleUpdate({ agent: "explorer", config: { maxExecutionTimeMs: false } }, ctx);
		assert.equal(cleared.isError, false);
		assert.doesNotMatch(fs.readFileSync(filePath, "utf-8"), /^maxExecutionTimeMs:/m);

		const invalid = handleUpdate({ agent: "explorer", config: { maxExecutionTimeMs: Number.MAX_SAFE_INTEGER + 1 } }, ctx);
		assert.equal(invalid.isError, true);
		assert.match(readText(invalid), /config\.maxExecutionTimeMs must be a positive safe integer or false/);
	});

	it("creates agents with completion guard disabled", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const result = handleCreate(
			{ config: { name: "test-runner", description: "Run tests", scope: "project", tools: "read, grep, bash, ls", completionGuard: false } },
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "test-runner.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^completionGuard: false$/m);

		const got = handleManagementAction("get", { agent: "test-runner" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Completion guard: false/);
	});

	it("rejects non-boolean completion guard config", () => {
		const result = handleCreate(
			{ config: { name: "test-runner", description: "Run tests", scope: "project", completionGuard: "false" } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config\.completionGuard must be a boolean/);
	});

	it("creates agents with subagent-only extensions", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const result = handleCreate(
			{ config: { name: "child-tool-user", description: "Uses child tools", scope: "project", subagentOnlyExtensions: "./tools/child-only.ts, /opt/pi/child.ts" } },
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "child-tool-user.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^subagentOnlyExtensions: \.\/tools\/child-only\.ts, \/opt\/pi\/child\.ts$/m);

		const got = handleManagementAction("get", { agent: "child-tool-user" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Subagent-only extensions: \.\/tools\/child-only\.ts, \/opt\/pi\/child\.ts/);
	});

	it("does not serialize settings overrides into custom agent frontmatter during updates", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-6" }] } };
		const settingsPath = path.join(tempDir, ".pi", "settings.json");
		const agentPath = path.join(tempDir, ".pi", "agents", "implementer.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					implementer: {
						model: "anthropic/claude-sonnet-4-6",
						systemPromptMode: "append",
						inheritProjectContext: true,
						inheritSkills: true,
					},
				},
			},
		}, null, 2), "utf-8");
		fs.writeFileSync(agentPath, `---
name: implementer
description: TDD implementer
---

Drive the failing test first.
`, "utf-8");

		const got = handleManagementAction("get", { agent: "implementer" }, ctx);
		assert.equal(got.isError, false);
		const beforeText = readText(got);
		assert.match(beforeText, /Model: anthropic\/claude-sonnet-4-6/);
		assert.match(beforeText, /System prompt mode: append/);
		assert.match(beforeText, /Inherit project context: true/);
		assert.match(beforeText, /Inherit skills: true/);

		const updated = handleUpdate(
			{ agent: "implementer", config: { description: "Updated implementer" } },
			ctx,
		);
		assert.equal(updated.isError, false);

		const content = fs.readFileSync(agentPath, "utf-8");
		assert.match(content, /^description: Updated implementer$/m);
		assert.doesNotMatch(content, /^model:/m);
		assert.doesNotMatch(content, /^systemPromptMode:/m);
		assert.doesNotMatch(content, /^inheritProjectContext:/m);
		assert.doesNotMatch(content, /^inheritSkills:/m);

		const gotAfter = handleManagementAction("get", { agent: "implementer" }, ctx);
		assert.equal(gotAfter.isError, false);
		const afterText = readText(gotAfter);
		assert.match(afterText, /Model: anthropic\/claude-sonnet-4-6/);
		assert.match(afterText, /System prompt mode: append/);
		assert.match(afterText, /Inherit project context: true/);
		assert.match(afterText, /Inherit skills: true/);
	});

	it("preserves explicit default-like frontmatter that blocks settings overrides during updates", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const settingsPath = path.join(tempDir, ".pi", "settings.json");
		const agentPath = path.join(tempDir, ".pi", "agents", "implementer.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					implementer: {
						thinking: "high",
						fallbackModels: ["openai/gpt-5-mini"],
						tools: ["bash"],
						skills: ["override-skill"],
						defaultContext: "fork",
						completionGuard: false,
						toolBudget: { hard: 3 },
					},
				},
			},
		}, null, 2), "utf-8");
		fs.writeFileSync(agentPath, `---
name: implementer
description: TDD implementer
fallbackModels:
thinking: off
tools:
skills:
defaultContext:
completionGuard: true
toolBudget:
---

Drive the failing test first.
`, "utf-8");

		const got = handleManagementAction("get", { agent: "implementer" }, ctx);
		assert.equal(got.isError, false);
		const beforeText = readText(got);
		assert.match(beforeText, /Thinking: off/);
		assert.doesNotMatch(beforeText, /Thinking: high/);

		const updated = handleUpdate(
			{ agent: "implementer", config: { description: "Updated implementer" } },
			ctx,
		);
		assert.equal(updated.isError, false);

		const content = fs.readFileSync(agentPath, "utf-8");
		assert.match(content, /^description: Updated implementer$/m);
		assert.match(content, /^fallbackModels: ?$/m);
		assert.match(content, /^thinking: off$/m);
		assert.match(content, /^tools: ?$/m);
		assert.match(content, /^skills: ?$/m);
		assert.match(content, /^defaultContext: ?$/m);
		assert.match(content, /^completionGuard: true$/m);
		assert.match(content, /^toolBudget: ?$/m);

		const gotAfter = handleManagementAction("get", { agent: "implementer" }, ctx);
		assert.equal(gotAfter.isError, false);
		const afterText = readText(gotAfter);
		assert.match(afterText, /Thinking: off/);
		assert.doesNotMatch(afterText, /Thinking: high/);
	});

	it("rejects saved-chain get and leaves JSON chain files untouched while list stays agent-only", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		const original = JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [{ agent: "scout", task: "Return targets" }],
		}, null, 2);
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

	it("reports builtin runtime-loaded model mappings from current session state", () => {
		const ctx = {
			cwd: tempDir,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai", id: "gpt-5-mini" },
					{ provider: "anthropic", id: "claude-sonnet-4" },
				],
			},
			model: { provider: "openai", id: "gpt-5-mini" },
		};

		const result = handleManagementAction("models", {}, ctx);
		const text = readText(result);
		assert.equal(result.isError, false);
		assert.match(text, /^Builtin subagent models/m);
		assert.match(text, /Current session model:\n  openai\/gpt-5-mini/);
		assert.match(text, /(?:^|\n)scout\n  model:\n    openai\/gpt-5-mini\n  source: inherits current session model(?:\n|$)/);
	});

	it("reports override source and disabled builtin state in runtime model mappings", () => {
		const projectSettingsPath = path.join(tempDir, ".pi", "settings.json");
		fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
		fs.writeFileSync(projectSettingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					reviewer: { model: "claude-sonnet-4", disabled: true },
				},
			},
		}, null, 2), "utf-8");

		const ctx = {
			cwd: tempDir,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai", id: "gpt-5-mini" },
					{ provider: "anthropic", id: "claude-sonnet-4" },
				],
			},
			model: { provider: "openai", id: "gpt-5-mini" },
		};

		const result = handleManagementAction("models", { agent: "reviewer" }, ctx);
		const text = readText(result);
		assert.equal(result.isError, false);
		assert.match(text, /^Builtin subagent model/m);
		assert.match(text, /Agent: reviewer/);
		assert.match(text, /Effective model:\n  anthropic\/claude-sonnet-4/);
		assert.match(text, /Source: project override/);
		assert.match(text, /Requested model setting:\n  claude-sonnet-4/);
		assert.match(text, /Disabled: true/);
		assert.match(text.replaceAll("\\", "/"), /Override file:\n  .*\.pi\/settings\.json/);
	});

	it("rejects unknown builtin filters for runtime model mappings", () => {
		const result = handleManagementAction("models", { agent: "not-a-builtin" }, {
			cwd: tempDir,
			modelRegistry: { getAvailable: () => [] },
		});

		assert.equal(result.isError, true);
		assert.match(readText(result), /Builtin agent 'not-a-builtin' not found/);
	});

	it("creates delegate with its builtin prompt defaults", () => {
		const result = handleCreate(
			{ config: { name: "delegate", description: "Delegate helper", scope: "project" } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "delegate.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /systemPromptMode: append/);
		assert.match(content, /inheritProjectContext: true/);
		assert.match(content, /inheritSkills: false/);
	});

});
