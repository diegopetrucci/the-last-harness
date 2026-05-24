import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";

const jiti = createJiti(import.meta.url);
const { registerTlhPrimaryAgentRuntime } = await jiti.import("../extensions/the-last-harness/primary-agent-runtime.ts");

function createPiHarness() {
	const commands = new Map();
	const shortcuts = new Map();
	return {
		events: [],
		commands,
		shortcuts,
		activeTools: [],
		allTools: [{ name: "subagent" }],
		thinkingLevel: "normal",
		on(name, handler) {
			this.events.push({ name, handler });
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut(name, options) {
			shortcuts.set(name, options);
		},
		getAllTools() {
			return this.allTools;
		},
		getActiveTools() {
			return this.activeTools;
		},
		setActiveTools(tools) {
			this.activeTools = tools;
		},
		async setModel(model) {
			this.model = model;
			return true;
		},
		getThinkingLevel() {
			return this.thinkingLevel;
		},
		setThinkingLevel(level) {
			this.thinkingLevel = level;
		},
		appendEntry() {},
	};
}

function createToolCallContext(branchEntries = [], notifications, overrides = {}) {
	return {
		cwd: process.cwd(),
		sessionManager: { getBranch: () => branchEntries },
		ui: {
			notify(message, type = "info") {
				notifications?.push({ message, type });
			},
		},
		modelRegistry: {
			getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4" }],
		},
		model: { provider: "openai-codex", id: "gpt-5.4" },
		...overrides,
	};
}

function registerRuntimeHarness(options = {}) {
	const pi = createPiHarness();
	const runtime = registerTlhPrimaryAgentRuntime(pi, { env: {}, ...options });
	const toolCall = pi.events.find((event) => event.name === "tool_call")?.handler;
	assert.equal(typeof toolCall, "function");
	return { pi, runtime, toolCall };
}

function tempFixture() {
	const dir = mkdtempSync(join(tmpdir(), "tlh-primary-runtime-test-"));
	const home = join(dir, "home");
	const agent = join(dir, "agent");
	const cwd = join(dir, "workspace");
	mkdirSync(home, { recursive: true });
	mkdirSync(agent, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { dir, home, agent, cwd };
}

async function withEnv(env, fn) {
	const previous = new Map();
	for (const key of Object.keys(env)) {
		previous.set(key, process.env[key]);
		if (env[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = env[key];
		}
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function writePrimaryConfig(agentDir, primaryAgent = {}) {
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ tlh: { primaryAgent } }, null, 2)}\n`);
}

function createPrimaryPrompt(name, overrides = {}) {
	return {
		name,
		description: "Test primary",
		tools: ["subagent"],
		systemPrompt: "test",
		filePath: `agents/primary/${name}.md`,
		...overrides,
	};
}

function selectablePrimaryAgents() {
	return new Map([
		["architect", createPrimaryPrompt("architect")],
		["rush", createPrimaryPrompt("rush")],
		["product", createPrimaryPrompt("product")],
		["bug-hunter", createPrimaryPrompt("bug-hunter")],
	]);
}

function rushLikePrimary(name = "architect") {
	return createPrimaryPrompt(name, {
		model: "anthropic/claude-opus-4-7",
		tlhOpenaiModels: ["openai-codex/gpt-5.5", "openai/gpt-5.5"],
		thinking: "low",
		tlhOpenaiThinking: "off",
		applyModel: true,
		applyThinking: true,
	});
}

function createCommandContext(branchEntries = [], overrides = {}) {
	const notifications = [];
	return { notifications, ctx: createToolCallContext(branchEntries, notifications, overrides) };
}

test("disabled primary mode still injects provider-aware subagent models", async () => {
	const { toolCall } = registerRuntimeHarness();
	const event = { toolName: "subagent", input: { agent: "developer", context: "resume" } };
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "disabled" } },
	]);

	assert.equal(await toolCall(event, ctx), undefined);
	assert.equal(event.input.model, "openai-codex/gpt-5.4");
	assert.equal(event.input.agentScope, undefined);
	assert.equal(event.input.context, "resume");
});

test("enabled primary mode validates subagent input after injecting provider-aware models", async () => {
	const { toolCall } = registerRuntimeHarness();
	const event = { toolName: "subagent", input: { agent: "developer", context: "resume" } };
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } },
	]);

	const result = await toolCall(event, ctx);
	assert.deepEqual(result, {
		block: true,
		reason:
			'TLH primary-agent subagent execution may not use context: "resume". TLH child sessions must start fresh so parent primary-agent/Gnosis context is not leaked.',
	});
	assert.equal(event.input.model, "openai-codex/gpt-5.4");
	assert.equal(event.input.agentScope, "user");
});

test("/switch-primary-agent includes Rush completions, usage, and status strings", async () => {
	const { pi } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
	const command = pi.commands.get("switch-primary-agent");
	assert.ok(command, "registers /switch-primary-agent");
	assert.equal(pi.commands.has("agent"), false);
	assert.equal(pi.commands.has("architect"), false);
	assert.equal(pi.commands.has("tlh"), false);
	assert.equal(pi.commands.has("harness"), false);

	assert.deepEqual(
		(await command.getArgumentCompletions("r")).map((completion) => completion.value),
		["rush", "reset"],
	);
	assert.deepEqual(
		(await command.getArgumentCompletions("default r")).map((completion) => completion.value),
		["default rush", "default reset"],
	);

	const usage = createCommandContext();
	await command.handler("rush extra", usage.ctx);
	assert.deepEqual(usage.notifications.at(-1), {
		message: "Usage: /switch-primary-agent architect|rush|product|bug-hunter|disabled",
		type: "error",
	});

	const status = createCommandContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
	]);
	await command.handler("status", status.ctx);
	assert.equal(status.notifications.at(-1)?.type, "info");
	assert.match(status.notifications.at(-1)?.message ?? "", /Primary agent: rush\./);
});

test("/switch-primary-agent default writes tlh.primaryAgent with a backup", async () => {
	const fixture = tempFixture();
	const initialSettings = `${JSON.stringify({ tlh: { primaryAgent: { selected: "architect" } } }, null, 2)}\n`;

	try {
		writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			const { pi } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
			const command = pi.commands.get("switch-primary-agent");
			assert.ok(command, "registers /switch-primary-agent");

			const writeDefault = createCommandContext([], { cwd: fixture.cwd });
			await command.handler("default rush", writeDefault.ctx);

			const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
			assert.deepEqual(written.tlh.primaryAgent, { enabled: true, selected: "rush" });
			const backups = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-"));
			assert.equal(backups.length, 1);
			assert.equal(readFileSync(join(fixture.agent, backups[0]), "utf8"), initialSettings);
			assert.equal(writeDefault.notifications.at(-1)?.type, "info");
			assert.match(writeDefault.notifications.at(-1)?.message ?? "", /Updated TLH primary-agent persistent default/);
		});
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("Rush blocks developer delegation even inside nested subagent plans", async () => {
	const { toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
	const event = {
		toolName: "subagent",
		input: {
			chain: [
				{
					parallel: [
						{ agent: "code-reviewer", prompt: "Review the diff" },
						{ agent: "developer", prompt: "Implement the fix" },
					],
				},
			],
		},
	};
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
	]);

	const result = await toolCall(event, ctx);
	assert.deepEqual(result, {
		block: true,
		reason:
			"TLH Rush may not delegate implementation to developer. Rush must edit directly; use code-reviewer, repo-scout, diff-summarizer, librarian, or oracle only when Rush prompt rules allow it.",
	});
});

test("primary runtime applies OpenAI Rush-like metadata defaults with no settings opt-in", async () => {
	const fixture = tempFixture();
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);

	try {
		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
			assert.ok(runtime, "runtime should register outside child sessions");

			await runtime.applySessionStart({
				cwd: fixture.cwd,
				sessionManager: { getBranch: () => [] },
				ui: { notify() {} },
				modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.5" }] },
				model: { provider: "openai-codex", id: "gpt-5.4" },
			});

			assert.deepEqual(pi.model, { provider: "openai-codex", id: "gpt-5.5" });
			assert.equal(pi.thinkingLevel, "off");
		});
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("primary runtime falls back to Anthropic Rush-like metadata defaults when only Anthropic is available", async () => {
	const fixture = tempFixture();
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);

	try {
		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
			assert.ok(runtime, "runtime should register outside child sessions");

			await runtime.applySessionStart({
				cwd: fixture.cwd,
				sessionManager: { getBranch: () => [] },
				ui: { notify() {} },
				modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-7" }] },
				model: { provider: "openai-codex", id: "gpt-5.4" },
			});

			assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-7" });
			assert.equal(pi.thinkingLevel, "low");
		});
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("primary runtime respects explicit false settings over Rush-like metadata defaults", async () => {
	const fixture = tempFixture();
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);

	try {
		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			writePrimaryConfig(fixture.agent, { applyModel: false, applyThinking: false });
			const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
			assert.ok(runtime, "runtime should register outside child sessions");

			await runtime.applySessionStart({
				cwd: fixture.cwd,
				sessionManager: { getBranch: () => [] },
				ui: { notify() {} },
				modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.5" }] },
				model: { provider: "openai-codex", id: "gpt-5.4" },
			});

			assert.equal(pi.model, undefined);
			assert.equal(pi.thinkingLevel, "normal");
		});
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});
