import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { cleanupTempDir, createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { TLH_DEFAULT_COMMIT_ATTRIBUTION } = await jiti.import("../extensions/the-last-harness/attribution.ts");
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
	const beforeAgentStart = pi.events.find((event) => event.name === "before_agent_start")?.handler;
	const toolCall = pi.events.find((event) => event.name === "tool_call")?.handler;
	assert.equal(typeof beforeAgentStart, "function");
	assert.equal(typeof toolCall, "function");
	return { pi, runtime, beforeAgentStart, toolCall };
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

test("before_agent_start adds TLH commit attribution guidance only when enabled", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { beforeAgentStart } = registerRuntimeHarness();
		const enabledPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
		assert.match(enabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
		assert.match(enabledPrompt.systemPrompt, /Co-authored-by: The Last Harness <hi@thelastharness\.com>/);

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		const disabledPrompt = await beforeAgentStart(
			{ systemPrompt: "base prompt" },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.doesNotMatch(disabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
	});
});

test("child mode keeps parent-only controls disabled while applying commit attribution prompt and bash guard", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		const runtime = registerTlhPrimaryAgentRuntime(pi, { env: { PI_SUBAGENT_CHILD: "1" } });
		assert.equal(runtime, undefined);
		assert.deepEqual([...pi.commands.keys()], []);
		assert.deepEqual([...pi.shortcuts.keys()], []);
		assert.deepEqual(
			pi.events.map((event) => event.name),
			["before_agent_start", "tool_call"],
		);

		const beforeAgentStart = pi.events.find((event) => event.name === "before_agent_start")?.handler;
		const toolCall = pi.events.find((event) => event.name === "tool_call")?.handler;
		assert.equal(typeof beforeAgentStart, "function");
		assert.equal(typeof toolCall, "function");

		const enabledPrompt = await beforeAgentStart(
			{ systemPrompt: "base prompt" },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.match(enabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
		assert.match(enabledPrompt.systemPrompt, /Co-authored-by: The Last Harness <hi@thelastharness\.com>/);

		const blockedCommit = await toolCall(
			{ toolName: "bash", input: { command: 'git commit -m "ship it"' } },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.equal(blockedCommit?.block, true);
		assert.match(blockedCommit?.reason ?? "", /TLH attribution footer/);

		const childSubagentCall = { toolName: "subagent", input: { agent: "developer", context: "resume" } };
		assert.equal(await toolCall(childSubagentCall, createToolCallContext([], undefined, { cwd: fixture.cwd })), undefined);
		assert.equal(childSubagentCall.input.agentScope, undefined);
		assert.equal(childSubagentCall.input.context, "resume");

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		const disabledPrompt = await beforeAgentStart(
			{ systemPrompt: "base prompt" },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.doesNotMatch(disabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: 'git commit -m "ship it"' } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
	});
});

test("tool_call blocks obvious unattributed bash git commits only when attribution is enabled", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const attributedHereDoc = `git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;
	const wrappedAttributedHereDoc = `if true; then git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF\nfi`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of [
			'git commit -m "ship it"',
			'git -C repo commit -m "ship it"',
			'git commit -F-',
			'if true; then git commit -m "ship it"; fi',
			'if false; then :; else git commit -m "ship it"; fi',
			'for f in x; do git commit -m "ship it"; done',
			'! git commit -m "ship it"',
		]) {
			const blocked = await toolCall(
				{ toolName: "bash", input: { command } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			);
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}
		assert.equal(
			await toolCall({ toolName: "bash", input: { command: attributedHereDoc } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: wrappedAttributedHereDoc } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		const mixedCommits = await toolCall(
			{ toolName: "bash", input: { command: `${attributedHereDoc}\ngit commit -m "ship it"` } },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.equal(mixedCommits?.block, true);
		assert.match(mixedCommits?.reason ?? "", /TLH attribution footer/);
		assert.equal(
			await toolCall({ toolName: "bash", input: { command: 'git commit -F .git/COMMIT_EDITMSG' } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
			undefined,
		);

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: 'if true; then git commit -m "ship it"; fi' } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
	});
});

test("enabled primary mode allows approved delegation targets and forces safe top-level defaults", async () => {
	const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
	const event = {
		toolName: "subagent",
		input: {
			tasks: [{ agent: "repo-scout", prompt: "Map the repository" }],
			chain: [{ parallel: [{ agent: "web-scout", prompt: "Research upstream release notes" }] }],
		},
	};
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } },
	]);

	assert.equal(await toolCall(event, ctx), undefined);
	assert.equal(event.input.agentScope, "user");
	assert.equal(event.input.context, "fresh");
});

test("enabled primary mode blocks disallowed nested delegation targets after forcing safe defaults", async () => {
	const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
	const event = {
		toolName: "subagent",
		input: {
			tasks: [{ agent: "repo-scout", prompt: "Inspect the repo" }],
			chain: [{ parallel: [{ agent: "planner", prompt: "Plan the work" }] }],
		},
	};
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } },
	]);

	assert.deepEqual(await toolCall(event, ctx), {
		block: true,
		reason:
			"TLH primary agents may delegate only to: developer, code-reviewer, repo-scout, diff-summarizer, librarian, web-scout, oracle. Disallowed target(s): planner.",
	});
	assert.equal(event.input.agentScope, "user");
	assert.equal(event.input.context, "fresh");
});

test("enabled primary mode allows safe management calls and blocks non-user management scopes", async () => {
	const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } },
	]);
	const listEvent = { toolName: "subagent", input: { action: "list" } };
	const getEvent = { toolName: "subagent", input: { action: "get", agentScope: "" } };
	const blockedEvent = { toolName: "subagent", input: { action: "get", agentScope: "project" } };

	assert.equal(await toolCall(listEvent, ctx), undefined);
	assert.equal(listEvent.input.agentScope, "user");
	assert.equal(await toolCall(getEvent, ctx), undefined);
	assert.equal(getEvent.input.agentScope, "user");
	assert.deepEqual(await toolCall(blockedEvent, ctx), {
		block: true,
		reason: 'TLH primary-agent subagent get calls may not use agentScope: "project". TLH minor agents must run from the isolated user scope.',
	});
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
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
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
		cleanupTempDir(fixture);
	}
});

test("/switch-primary-agent default refuses normal Pi settings", async () => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
	const normalAgent = join(fixture.home, ".pi", "agent");

	try {
		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: normalAgent }, async () => {
			const { pi } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
			const command = pi.commands.get("switch-primary-agent");
			assert.ok(command, "registers /switch-primary-agent");

			const writeDefault = createCommandContext([], { cwd: fixture.cwd });
			await command.handler("default rush", writeDefault.ctx);

			assert.equal(writeDefault.notifications.at(-1)?.type, "error");
			assert.match(writeDefault.notifications.at(-1)?.message ?? "", /isolated TLH profile|normal Pi config/);
		});
	} finally {
		cleanupTempDir(fixture);
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
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
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
		cleanupTempDir(fixture);
	}
});

test("primary runtime falls back to Anthropic Rush-like metadata defaults when only Anthropic is available", async () => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
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
		cleanupTempDir(fixture);
	}
});

test("primary runtime respects explicit false settings over Rush-like metadata defaults", async () => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
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
		cleanupTempDir(fixture);
	}
});
