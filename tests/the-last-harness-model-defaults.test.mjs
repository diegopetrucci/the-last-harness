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
	tlhOpenaiModels: ["openai-codex/gpt-5.4"],
};

const codeReviewer = {
	name: "code-reviewer",
	model: "openai-codex/gpt-5.5",
	tlhOpenaiModels: ["openai-codex/gpt-5.5"],
	tlhAnthropicModels: ["anthropic/claude-opus-4-8"],
};

const rushLikePrimary = {
	name: "rush",
	model: "anthropic/claude-opus-4-8",
	tlhOpenaiModels: ["openai-codex/gpt-5.5"],
	thinking: "low",
	tlhOpenaiThinking: "off",
	preferCurrentOpenaiModel: true,
};

const anthropicFirstPrimary = {
	...rushLikePrimary,
	name: "architect",
	preferCurrentOpenaiModel: undefined,
};

const agents = new Map([
	[developer.name, developer],
	[codeReviewer.name, codeReviewer],
]);

const anthropicAvailable = [
	{ provider: "anthropic", id: "claude-sonnet-4-6" },
	{ provider: "anthropic", id: "claude-opus-4-8" },
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

test("provider-aware model resolver does not auto-inject OpenAI API models", () => {
	const input = { agent: "code-reviewer", task: "Review the diff" };
	assert.equal(selectProviderAwareAgentModelId(codeReviewer, openaiAvailable, "openai"), undefined);
	assert.equal(applyProviderAwareSubagentModels(input, agents, openaiAvailable, "openai"), 0);
	assert.equal(input.model, undefined);
});

test("provider-aware model resolver keeps Codex defaults even when regular OpenAI models are also available", () => {
	const available = [...codexAvailable, ...openaiAvailable];
	assert.equal(selectProviderAwareAgentModelId(developer, available, "openai"), "openai-codex/gpt-5.4");
	assert.equal(selectProviderAwareAgentModelId(developer, available, "openai-codex"), "openai-codex/gpt-5.4");
});

test("provider-aware primary defaults switch Rush-like thinking off for bundled Codex models", () => {
	assert.deepEqual(selectProviderAwareAgentDefaults(rushLikePrimary, codexAvailable, "openai-codex"), {
		model: { provider: "openai-codex", id: "gpt-5.5" },
		thinking: "off",
	});
	assert.deepEqual(selectProviderAwareAgentDefaults(rushLikePrimary, [...codexAvailable, ...openaiAvailable], "openai"), {
		model: { provider: "openai-codex", id: "gpt-5.5" },
		thinking: "off",
	});
});

test("provider-aware primary defaults keep Anthropic when regular OpenAI is available without bundled Codex", () => {
	const mixedOpenaiAvailable = [...anthropicAvailable, ...openaiAvailable];

	assert.deepEqual(selectProviderAwareAgentDefaults(rushLikePrimary, mixedOpenaiAvailable, "openai"), {
		model: { provider: "anthropic", id: "claude-opus-4-8" },
		thinking: "low",
	});
});


test("provider-aware primary defaults keep the Anthropic default first without the Rush-only opt-in", () => {
	const mixedCodexAvailable = [...anthropicAvailable, ...codexAvailable];
	const mixedOpenaiAvailable = [...anthropicAvailable, ...openaiAvailable];

	assert.deepEqual(selectProviderAwareAgentDefaults(anthropicFirstPrimary, mixedCodexAvailable, "openai-codex"), {
		model: { provider: "anthropic", id: "claude-opus-4-8" },
		thinking: "low",
	});
	assert.deepEqual(selectProviderAwareAgentDefaults(anthropicFirstPrimary, mixedOpenaiAvailable, "openai"), {
		model: { provider: "anthropic", id: "claude-opus-4-8" },
		thinking: "low",
	});
});

test("provider-aware primary defaults fall back to Anthropic thinking when OpenAI models are unavailable", () => {
	assert.deepEqual(selectProviderAwareAgentDefaults(rushLikePrimary, anthropicAvailable, "openai-codex"), {
		model: { provider: "anthropic", id: "claude-opus-4-8" },
		thinking: "low",
	});
	assert.deepEqual(selectProviderAwareAgentDefaults({ ...rushLikePrimary, tlhOpenaiThinking: undefined }, codexAvailable, "openai-codex"), {
		model: { provider: "openai-codex", id: "gpt-5.5" },
		thinking: "low",
	});
});

// --- tlhAnthropicModels: new tests (ticket tlht-k7h8) ---

test("tlhAnthropicModels: selects Anthropic fallback when primary OpenAI model is absent from registry", () => {
	const agentWithAnthropicFallback = {
		name: "test-agent",
		model: "openai/gpt-5.5",
		tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
	};
	// No currentProvider given — iterates tlhAnthropicModels and finds the Anthropic model
	assert.equal(
		selectProviderAwareAgentModelId(agentWithAnthropicFallback, anthropicAvailable, undefined),
		"anthropic/claude-sonnet-4-6",
	);
	// Same result when currentProvider is explicitly "anthropic"
	assert.equal(
		selectProviderAwareAgentModelId(agentWithAnthropicFallback, anthropicAvailable, "anthropic"),
		"anthropic/claude-sonnet-4-6",
	);
});

test("tlhAnthropicModels: current-provider Anthropic candidate preferred on Anthropic session", () => {
	const agentWithBothFallbacks = {
		name: "test-agent",
		model: "openai/gpt-5.5",
		tlhOpenaiModels: ["openai-codex/gpt-5.5"],
		tlhAnthropicModels: ["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6"],
	};
	// currentProvider="anthropic": step-2 current-provider check picks first matching entry
	assert.equal(
		selectProviderAwareAgentModelId(agentWithBothFallbacks, anthropicAvailable, "anthropic"),
		"anthropic/claude-opus-4-8",
	);
	// When only the second candidate is available the fallback iteration finds it
	const sonetOnly = [{ provider: "anthropic", id: "claude-sonnet-4-6" }];
	assert.equal(
		selectProviderAwareAgentModelId(agentWithBothFallbacks, sonetOnly, "anthropic"),
		"anthropic/claude-sonnet-4-6",
	);
});

test("tlhAnthropicModels: regression – agents with only tlhOpenaiModels are unaffected", () => {
	const agentOpenaiOnly = {
		name: "openai-only",
		model: "openai/gpt-5.5",
		tlhOpenaiModels: ["openai-codex/gpt-5.4"],
		// no tlhAnthropicModels
	};
	// Codex available: selects the OpenAI fallback
	assert.equal(
		selectProviderAwareAgentModelId(agentOpenaiOnly, codexAvailable, "openai-codex"),
		"openai-codex/gpt-5.4",
	);
	// Anthropic-only environment: no tlhAnthropicModels declared → returns undefined
	assert.equal(
		selectProviderAwareAgentModelId(agentOpenaiOnly, anthropicAvailable, "anthropic"),
		undefined,
	);
	// applyProviderAwareSubagentModels: existing developer agent still works exactly as before
	const input = { agent: "developer", task: "Implement the ticket" };
	assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 1);
	assert.equal(input.model, "openai-codex/gpt-5.4");
});

test("provider-aware subagent mutation preserves explicit user-supplied model values", () => {
	const input = { agent: "developer", task: "Implement the ticket", model: "openai/gpt-5.4" };
	assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 0);
	assert.equal(input.model, "openai/gpt-5.4");
});

test("provider-aware subagent mutation handles parallel tasks", () => {
	const input = {
		tasks: [
			{ agent: "developer", task: "Implement" },
			{ agent: "code-reviewer", task: "Review", model: "anthropic/claude-opus-4-8" },
			{ agent: "unknown", task: "Leave alone" },
		],
	};

	assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 1);
	assert.equal(input.tasks[0].model, "openai-codex/gpt-5.4");
	assert.equal(input.tasks[1].model, "anthropic/claude-opus-4-8");
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

	assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 1);
	assert.equal(input.chain[0].model, "openai-codex/gpt-5.4");
	assert.equal(input.chain[1].parallel[0].model, undefined); // code-reviewer default already matches; no injection needed
	assert.equal(input.chain[1].parallel[1].model, "openai/gpt-5.4");
});
