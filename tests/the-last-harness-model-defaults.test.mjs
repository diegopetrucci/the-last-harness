import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	applyProviderAwareSubagentModels,
	selectProviderAwareAgentDefaults,
	selectProviderAwareAgentModelId,
} = await jiti.import("../extensions/the-last-harness/model-defaults.ts");

const developer = {
	name: "developer",
	model: "anthropic/claude-sonnet-4-6",
	tlhOpenaiModels: ["openai-codex/gpt-5.4", "openai/gpt-5.4"],
};

const codeReviewer = {
	name: "code-reviewer",
	model: "anthropic/claude-opus-4-7",
	tlhOpenaiModels: ["openai-codex/gpt-5.5", "openai/gpt-5.5"],
};

const rushLikePrimary = {
	name: "rush",
	model: "anthropic/claude-opus-4-7",
	tlhOpenaiModels: ["openai-codex/gpt-5.5", "openai/gpt-5.5"],
	thinking: "low",
	tlhOpenaiThinking: "off",
};

const agents = new Map([
	[developer.name, developer],
	[codeReviewer.name, codeReviewer],
]);

const anthropicAvailable = [
	{ provider: "anthropic", id: "claude-sonnet-4-6" },
	{ provider: "anthropic", id: "claude-opus-4-7" },
];

const codexAvailable = [
	{ provider: "openai-codex", id: "gpt-5.4" },
	{ provider: "openai-codex", id: "gpt-5.5" },
];

const openaiAvailable = [
	{ provider: "openai", id: "gpt-5.4" },
	{ provider: "openai", id: "gpt-5.5" },
];

test("provider-aware model resolver keeps Anthropic when the default model is available", () => {
	assert.equal(selectProviderAwareAgentModelId(developer, anthropicAvailable, "anthropic"), "anthropic/claude-sonnet-4-6");

	const input = { agent: "developer", task: "Implement the ticket" };
	assert.equal(applyProviderAwareSubagentModels(input, agents, anthropicAvailable, "anthropic"), 0);
	assert.deepEqual(input, { agent: "developer", task: "Implement the ticket" });
});

test("provider-aware model resolver picks OpenAI Codex when Anthropic is unavailable", () => {
	assert.equal(selectProviderAwareAgentModelId(developer, codexAvailable, "openai-codex"), "openai-codex/gpt-5.4");

	const input = { agent: "developer", task: "Implement the ticket" };
	assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 1);
	assert.equal(input.model, "openai-codex/gpt-5.4");
});

test("provider-aware model resolver falls back to OpenAI API key provider", () => {
	const input = { agent: "code-reviewer", task: "Review the diff" };
	assert.equal(applyProviderAwareSubagentModels(input, agents, openaiAvailable, "openai"), 1);
	assert.equal(input.model, "openai/gpt-5.5");
});

test("provider-aware model resolver prefers the current OpenAI provider when both are available", () => {
	const available = [...codexAvailable, ...openaiAvailable];
	assert.equal(selectProviderAwareAgentModelId(developer, available, "openai"), "openai/gpt-5.4");
	assert.equal(selectProviderAwareAgentModelId(developer, available, "openai-codex"), "openai-codex/gpt-5.4");
});

test("provider-aware primary defaults switch Rush-like thinking off for OpenAI providers", () => {
	assert.deepEqual(selectProviderAwareAgentDefaults(rushLikePrimary, codexAvailable, "openai-codex"), {
		model: { provider: "openai-codex", id: "gpt-5.5" },
		thinking: "off",
	});
	assert.deepEqual(selectProviderAwareAgentDefaults(rushLikePrimary, openaiAvailable, "openai"), {
		model: { provider: "openai", id: "gpt-5.5" },
		thinking: "off",
	});
});

test("provider-aware primary defaults prefer the current OpenAI provider over an available Anthropic default", () => {
	const mixedCodexAvailable = [...anthropicAvailable, ...codexAvailable];
	const mixedOpenaiAvailable = [...anthropicAvailable, ...openaiAvailable];

	assert.deepEqual(selectProviderAwareAgentDefaults(rushLikePrimary, mixedCodexAvailable, "openai-codex"), {
		model: { provider: "openai-codex", id: "gpt-5.5" },
		thinking: "off",
	});
	assert.deepEqual(selectProviderAwareAgentDefaults(rushLikePrimary, mixedOpenaiAvailable, "openai"), {
		model: { provider: "openai", id: "gpt-5.5" },
		thinking: "off",
	});
});

test("provider-aware primary defaults fall back to Anthropic thinking when OpenAI models are unavailable", () => {
	assert.deepEqual(selectProviderAwareAgentDefaults(rushLikePrimary, anthropicAvailable, "openai-codex"), {
		model: { provider: "anthropic", id: "claude-opus-4-7" },
		thinking: "low",
	});
	assert.deepEqual(selectProviderAwareAgentDefaults({ ...rushLikePrimary, tlhOpenaiThinking: undefined }, codexAvailable, "openai-codex"), {
		model: { provider: "openai-codex", id: "gpt-5.5" },
		thinking: "low",
	});
});

test("provider-aware subagent mutation preserves explicit model values", () => {
	const input = { agent: "developer", task: "Implement the ticket", model: "google/gemini-3-pro" };
	assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 0);
	assert.equal(input.model, "google/gemini-3-pro");
});

test("provider-aware subagent mutation handles parallel tasks", () => {
	const input = {
		tasks: [
			{ agent: "developer", task: "Implement" },
			{ agent: "code-reviewer", task: "Review", model: "anthropic/claude-opus-4-7" },
			{ agent: "unknown", task: "Leave alone" },
		],
	};

	assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 1);
	assert.equal(input.tasks[0].model, "openai-codex/gpt-5.4");
	assert.equal(input.tasks[1].model, "anthropic/claude-opus-4-7");
	assert.equal(input.tasks[2].model, undefined);
});

test("provider-aware subagent mutation handles chain sequential and parallel steps", () => {
	const input = {
		chain: [
			{ agent: "developer", task: "Implement {task}" },
			{
				parallel: [
					{ agent: "code-reviewer", task: "Review {previous}" },
					{ agent: "developer", task: "Smoke test {previous}", model: "openai/gpt-5.4" },
				],
			},
		],
	};

	assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 2);
	assert.equal(input.chain[0].model, "openai-codex/gpt-5.4");
	assert.equal(input.chain[1].parallel[0].model, "openai-codex/gpt-5.5");
	assert.equal(input.chain[1].parallel[1].model, "openai/gpt-5.4");
});
