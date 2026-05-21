import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";

const jiti = createJiti(import.meta.url);
const { registerTlhPrimaryAgentRuntime } = await jiti.import("../extensions/the-last-harness/primary-agent-runtime.ts");

function createPiHarness() {
	return {
		events: [],
		commands: [],
		shortcuts: [],
		activeTools: [],
		allTools: [{ name: "subagent" }],
		thinkingLevel: "normal",
		on(name, handler) {
			this.events.push({ name, handler });
		},
		registerCommand(name) {
			this.commands.push(name);
		},
		registerShortcut(name) {
			this.shortcuts.push(name);
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

function createToolCallContext(branchEntries = []) {
	return {
		cwd: process.cwd(),
		sessionManager: { getBranch: () => branchEntries },
		ui: { notify() {} },
		modelRegistry: {
			getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4" }],
		},
		model: { provider: "openai-codex", id: "gpt-5.4" },
	};
}

function registerRuntimeHarness() {
	const pi = createPiHarness();
	registerTlhPrimaryAgentRuntime(pi, { env: {} });
	const toolCall = pi.events.find((event) => event.name === "tool_call")?.handler;
	assert.equal(typeof toolCall, "function");
	return toolCall;
}

test("disabled primary mode still injects provider-aware subagent models", async () => {
	const toolCall = registerRuntimeHarness();
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
	const toolCall = registerRuntimeHarness();
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
