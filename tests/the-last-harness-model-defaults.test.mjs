import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	applyProviderAwareSubagentModels,
	resolveProviderAwareSubagentResolution,
	selectProviderAwareAgentDefaults,
	selectProviderAwareAgentModelId,
} = await jiti.import("../extensions/the-last-harness/model-defaults.ts");

const developer = {
	name: "developer",
	tlhOpenaiModels: ["openai-codex/gpt-5.4"],
	tlhAnthropicModels: ["anthropic/claude-sonnet-5"],
};

const codeReviewer = {
	name: "code-reviewer",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
	tlhAnthropicModels: ["anthropic/claude-opus-4-8"],
	preferOppositeProvider: true,
};

const oracle = {
	name: "oracle",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
	tlhAnthropicModels: ["anthropic/claude-opus-4-8"],
	preferOppositeProvider: true,
};

const anthropicParentPrefersCodexReviewer = {
	name: "anthropic-parent-prefers-codex-reviewer",
	model: "anthropic/claude-opus-4-8",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
	tlhAnthropicModels: ["anthropic/claude-opus-4-8"],
	preferOppositeProvider: true,
};

const openaiParentPrefersAnthropicReviewer = {
	name: "openai-parent-prefers-anthropic-reviewer",
	model: "openai-codex/gpt-5.6-sol",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
	tlhAnthropicModels: ["anthropic/claude-opus-4-8"],
	preferOppositeProvider: true,
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
	[oracle.name, oracle],
]);

const anthropicAvailable = [
	{ provider: "anthropic", id: "claude-sonnet-5" },
	{ provider: "anthropic", id: "claude-sonnet-4-6" },
	{ provider: "anthropic", id: "claude-opus-4-8" },
];

const codexAvailable = [
	{ provider: "openai-codex", id: "gpt-5.4" },
	{ provider: "openai-codex", id: "gpt-5.5" },
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
];

const openaiAvailable = [
	{ provider: "openai", id: "gpt-5.4" },
	{ provider: "openai", id: "gpt-5.5" },
];

const reasoningAnthropicAvailable = anthropicAvailable.map((model) => ({ ...model, reasoning: true }));
const reasoningCodexAvailable = codexAvailable.map((model) => ({ ...model, reasoning: true }));
const reasoningOpenaiAvailable = openaiAvailable.map((model) => ({ ...model, reasoning: true }));
const limitedReasoningAvailable = [
	{ provider: "anthropic", id: "claude-opus-4-8", reasoning: true, thinkingLevelMap: { xhigh: null } },
	{ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true, thinkingLevelMap: { xhigh: null } },
];
const primaryOnlyReasoningAvailable = [
	{ provider: "anthropic", id: "claude-opus-4-8", reasoning: true, thinkingLevelMap: { high: null } },
	{ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true },
];

const reducedIndependenceNotice = "TLH fell back to a same-provider review model; review independence is reduced.";

test("provider-aware model resolver follows active Anthropic provider for non-review subagents", () => {
	assert.equal(selectProviderAwareAgentModelId(developer, anthropicAvailable, "anthropic"), "anthropic/claude-sonnet-5");

	const input = { agent: "developer", task: "Implement the ticket" };
	assert.equal(applyProviderAwareSubagentModels(input, agents, anthropicAvailable, "anthropic"), 1);
	assert.equal(input.model, "anthropic/claude-sonnet-5");
});

test("provider-aware model resolver follows active provider for non-review subagents when both providers are available", () => {
	const available = [...anthropicAvailable, ...codexAvailable];

	// OpenAI-Codex is active → picks codex model, not Anthropic (the key fix)
	assert.equal(selectProviderAwareAgentModelId(developer, available, "openai-codex"), "openai-codex/gpt-5.4");
	const codexInput = { agent: "developer", task: "Implement the ticket" };
	assert.equal(applyProviderAwareSubagentModels(codexInput, agents, available, "openai-codex"), 1);
	assert.equal(codexInput.model, "openai-codex/gpt-5.4");

	// Anthropic is active → picks Anthropic model
	assert.equal(selectProviderAwareAgentModelId(developer, available, "anthropic"), "anthropic/claude-sonnet-5");
	const anthropicInput = { agent: "developer", task: "Implement the ticket" };
	assert.equal(applyProviderAwareSubagentModels(anthropicInput, agents, available, "anthropic"), 1);
	assert.equal(anthropicInput.model, "anthropic/claude-sonnet-5");
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


test("saved effort can use the current OpenAI session model without making it a bundled default", () => {
	const input = { agent: "developer", task: "Implement the ticket" };
	assert.equal(
		applyProviderAwareSubagentModels(
			input,
			agents,
			reasoningOpenaiAvailable,
			"openai",
			{ provider: "openai", id: "gpt-5.4" },
			{ agentOverrides: new Map([["developer", { thinking: "high" }]]) },
		),
		1,
	);
	assert.equal(input.model, "openai/gpt-5.4:high");
});


test("saved effort can use the current custom-provider session model only when needed", () => {
	const available = [{ provider: "custom-provider", id: "reasoner", reasoning: true }];
	const input = { agent: "developer", task: "Implement the ticket" };
	assert.equal(
		applyProviderAwareSubagentModels(
			input,
			agents,
			available,
			"custom-provider",
			{ provider: "custom-provider", id: "reasoner" },
			{ agentOverrides: new Map([["developer", { thinking: "high" }]]) },
		),
		1,
	);
	assert.equal(input.model, "custom-provider/reasoner:high");

	const noEffortInput = { agent: "developer", task: "Implement the ticket" };
	assert.equal(
		applyProviderAwareSubagentModels(
			noEffortInput,
			agents,
			available,
			"custom-provider",
			{ provider: "custom-provider", id: "reasoner" },
		),
		0,
	);
	assert.equal(noEffortInput.model, undefined);

	const unsupportedCurrentModel = [{ provider: "custom-provider", id: "limited", reasoning: true, thinkingLevelMap: { high: null } }];
	const unsupportedInput = { agent: "developer", task: "Implement the ticket" };
	const warnings = [];
	assert.equal(
		applyProviderAwareSubagentModels(
			unsupportedInput,
			agents,
			unsupportedCurrentModel,
			"custom-provider",
			{ provider: "custom-provider", id: "limited" },
			{
				agentOverrides: new Map([["developer", { thinking: "high" }]]),
				onWarning: (warning) => warnings.push(warning.message),
			},
		),
		0,
	);
	assert.equal(unsupportedInput.model, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /not supported by custom-provider\/limited/i);
	const unsupportedResolution = resolveProviderAwareSubagentResolution(
		developer,
		unsupportedCurrentModel,
		"custom-provider",
		{ provider: "custom-provider", id: "limited" },
		{ thinking: "high" },
	);
	assert.equal(unsupportedResolution.model, undefined);
	assert.equal(unsupportedResolution.thinking, undefined);
	assert.match(unsupportedResolution.warning, /not supported by custom-provider\/limited/i);
});

test("provider-aware model resolver keeps Codex defaults even when regular OpenAI models are also available", () => {
	const available = [...codexAvailable, ...openaiAvailable];
	assert.equal(selectProviderAwareAgentModelId(developer, available, "openai"), "openai-codex/gpt-5.4");
	assert.equal(selectProviderAwareAgentModelId(developer, available, "openai-codex"), "openai-codex/gpt-5.4");
});

test("provider-aware opposite-provider preference picks Codex for opted-in Anthropic-session reviewers", () => {
	const available = [...anthropicAvailable, ...codexAvailable];
	const agents = new Map([[anthropicParentPrefersCodexReviewer.name, anthropicParentPrefersCodexReviewer]]);

	assert.equal(
		selectProviderAwareAgentModelId(anthropicParentPrefersCodexReviewer, available, "anthropic"),
		"openai-codex/gpt-5.6-sol",
	);

	const input = { agent: anthropicParentPrefersCodexReviewer.name, task: "Review the diff" };
	assert.equal(applyProviderAwareSubagentModels(input, agents, available, "anthropic"), 1);
	assert.equal(input.model, "openai-codex/gpt-5.6-sol");
	assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-4-8"]);
	assert.equal(input.modelFallbackNotice, reducedIndependenceNotice);
});

test("provider-aware opposite-provider preference picks Anthropic for opted-in OpenAI-family reviewers", () => {
	const available = [...anthropicAvailable, ...codexAvailable];
	const agents = new Map([[openaiParentPrefersAnthropicReviewer.name, openaiParentPrefersAnthropicReviewer]]);

	assert.equal(
		selectProviderAwareAgentModelId(openaiParentPrefersAnthropicReviewer, available, "openai"),
		"anthropic/claude-opus-4-8",
	);
	assert.equal(
		selectProviderAwareAgentModelId(openaiParentPrefersAnthropicReviewer, available, "openai-codex"),
		"anthropic/claude-opus-4-8",
	);

	const input = { agent: openaiParentPrefersAnthropicReviewer.name, task: "Review the diff" };
	assert.equal(applyProviderAwareSubagentModels(input, agents, available, "openai-codex"), 1);
	assert.equal(input.model, "anthropic/claude-opus-4-8");
	assert.deepEqual(input.fallbackModels, ["openai-codex/gpt-5.6-sol"]);
	assert.equal(input.modelFallbackNotice, reducedIndependenceNotice);
});

test("provider-aware opposite-provider preference does not inject regular OpenAI API models for opted-in Anthropic sessions", () => {
	const agents = new Map([[anthropicParentPrefersCodexReviewer.name, anthropicParentPrefersCodexReviewer]]);
	const input = { agent: anthropicParentPrefersCodexReviewer.name, task: "Review the diff" };

	assert.equal(selectProviderAwareAgentModelId(anthropicParentPrefersCodexReviewer, openaiAvailable, "anthropic"), undefined);
	assert.equal(applyProviderAwareSubagentModels(input, agents, openaiAvailable, "anthropic"), 0);
	assert.equal(input.model, undefined);
});

test("provider-aware subagent mutation gives code-reviewer the opposite available provider with same-provider fallback", () => {
	const available = [...anthropicAvailable, ...codexAvailable];

	const anthropicInput = { agent: "code-reviewer" };
	assert.equal(applyProviderAwareSubagentModels(anthropicInput, agents, available, "anthropic"), 1);
	assert.equal(anthropicInput.model, "openai-codex/gpt-5.6-sol");
	assert.deepEqual(anthropicInput.fallbackModels, ["anthropic/claude-opus-4-8"]);
	assert.equal(anthropicInput.modelFallbackNotice, reducedIndependenceNotice);

	const codexInput = { agent: "code-reviewer" };
	assert.equal(applyProviderAwareSubagentModels(codexInput, agents, available, "openai-codex"), 1);
	assert.equal(codexInput.model, "anthropic/claude-opus-4-8");
	assert.deepEqual(codexInput.fallbackModels, ["openai-codex/gpt-5.6-sol"]);
	assert.equal(codexInput.modelFallbackNotice, reducedIndependenceNotice);

	const noOppositeInput = { agent: "code-reviewer" };
	assert.equal(applyProviderAwareSubagentModels(noOppositeInput, agents, openaiAvailable, "anthropic"), 0);
	assert.equal(Object.hasOwn(noOppositeInput, "model"), false);
	assert.equal(Object.hasOwn(noOppositeInput, "fallbackModels"), false);
	assert.equal(Object.hasOwn(noOppositeInput, "modelFallbackNotice"), false);
});

test("provider-aware subagent mutation gives code-reviewer and oracle current-session model fallback first", () => {
	const available = [...anthropicAvailable, ...codexAvailable];

	const reviewerInput = { agent: "code-reviewer" };
	assert.equal(
		applyProviderAwareSubagentModels(
			reviewerInput,
			agents,
			available,
			"anthropic",
			{ provider: "anthropic", id: "claude-sonnet-4-6" },
		),
		1,
	);
	assert.equal(reviewerInput.model, "openai-codex/gpt-5.6-sol");
	assert.deepEqual(reviewerInput.fallbackModels, ["anthropic/claude-sonnet-4-6"]);
	assert.equal(reviewerInput.modelFallbackNotice, reducedIndependenceNotice);

	const oracleInput = { agent: "oracle" };
	assert.equal(
		applyProviderAwareSubagentModels(
			oracleInput,
			agents,
			available,
			"openai-codex",
			{ provider: "openai-codex", id: "gpt-5.4" },
		),
		1,
	);
	assert.equal(oracleInput.model, "anthropic/claude-opus-4-8");
	assert.deepEqual(oracleInput.fallbackModels, ["openai-codex/gpt-5.4"]);
	assert.equal(oracleInput.modelFallbackNotice, reducedIndependenceNotice);
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
	assert.equal(Object.hasOwn(input, "fallbackModels"), false);
	assert.equal(Object.hasOwn(input, "modelFallbackNotice"), false);
});

test("provider-aware subagent mutation preserves explicit user-supplied model values", () => {
	const input = { agent: "developer", task: "Implement the ticket", model: "openai/gpt-5.4" };
	assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 0);
	assert.equal(input.model, "openai/gpt-5.4");
});


test("explicit plain model keeps its model and receives supported persisted thinking", () => {
	const input = { agent: "developer", task: "Implement", model: "anthropic/claude-sonnet-5" };
	assert.equal(
		applyProviderAwareSubagentModels(input, agents, reasoningAnthropicAvailable, "openai-codex", undefined, {
			agentOverrides: new Map([["developer", { model: "openai-codex/gpt-5.4", thinking: "high" }]]),
		}),
		1,
	);
	assert.equal(input.model, "anthropic/claude-sonnet-5:high");
});


test("explicit known thinking suffix wins over persisted thinking", () => {
	const input = { agent: "developer", task: "Implement", model: "anthropic/claude-sonnet-5:low" };
	assert.equal(
		applyProviderAwareSubagentModels(input, agents, reasoningAnthropicAvailable, "openai-codex", undefined, {
			agentOverrides: new Map([["developer", { thinking: "high" }]]),
		}),
		0,
	);
	assert.equal(input.model, "anthropic/claude-sonnet-5:low");
});


test("persisted minor-agent overrides win over bundled defaults and apply supported thinking suffixes", () => {
	const overrideAgents = new Map([[developer.name, developer]]);
	const input = { agent: "developer", task: "Implement the ticket" };
	assert.equal(
		applyProviderAwareSubagentModels(input, overrideAgents, reasoningAnthropicAvailable, "openai-codex", undefined, {
			agentOverrides: new Map([["developer", { model: "anthropic/claude-sonnet-5", thinking: "high" }]]),
		}),
		1,
	);
	assert.equal(input.model, "anthropic/claude-sonnet-5:high");
});


test("persisted thinking suffix is applied to opposite-provider fallbacks", () => {
	const input = { agent: "code-reviewer", task: "Review the diff" };
	assert.equal(
		applyProviderAwareSubagentModels(input, agents, [...reasoningAnthropicAvailable, ...reasoningCodexAvailable], "anthropic", undefined, {
			agentOverrides: new Map([["code-reviewer", { thinking: "high" }]]),
		}),
		1,
	);
	assert.equal(input.model, "openai-codex/gpt-5.6-sol:high");
	assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-4-8:high"]);
	assert.equal(input.modelFallbackNotice, reducedIndependenceNotice);
});


test("persisted off effort is explicit on selected and generated fallback models", () => {
	const input = { agent: "code-reviewer", task: "Review the diff" };
	assert.equal(
		applyProviderAwareSubagentModels(input, agents, [...reasoningAnthropicAvailable, ...reasoningCodexAvailable], "anthropic", undefined, {
			agentOverrides: new Map([["code-reviewer", { thinking: "off" }]]),
		}),
		1,
	);
	assert.equal(input.model, "openai-codex/gpt-5.6-sol:off");
	assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-4-8:off"]);
});


test("unsupported stored effort warns and falls back for that run", () => {
	const warnings = [];
	const input = { agent: "code-reviewer", task: "Review the diff" };
	assert.equal(
		applyProviderAwareSubagentModels(input, agents, limitedReasoningAvailable, "anthropic", undefined, {
			agentOverrides: new Map([["code-reviewer", { thinking: "xhigh" }]]),
			onWarning: (warning) => warnings.push(warning.message),
		}),
		1,
	);
	assert.equal(input.model, "openai-codex/gpt-5.6-sol");
	assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-4-8"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /stored minor-agent effort/i);
	assert.match(warnings[0], /openai-codex\/gpt-5\.6-sol/i);
});


test("supported primary saved effort survives an incompatible generated fallback", () => {
	const warnings = [];
	const input = { agent: "code-reviewer", task: "Review the diff" };
	assert.equal(
		applyProviderAwareSubagentModels(
			input,
			agents,
			primaryOnlyReasoningAvailable,
			"anthropic",
			undefined,
			{
				agentOverrides: new Map([["code-reviewer", { thinking: "high" }]]),
				onWarning: (warning) => warnings.push(warning.message),
			},
		),
		1,
	);
	assert.equal(input.model, "openai-codex/gpt-5.6-sol:high");
	assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-4-8"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /generated fallback anthropic\/claude-opus-4-8/i);
	assert.match(warnings[0], /bundled effort behavior/i);
});


test("caller-supplied fallbacks suppress warnings for an unused generated fallback", () => {
	const warnings = [];
	const input = {
		agent: "code-reviewer",
		task: "Review the diff",
		fallbackModels: ["custom/provider-model"],
	};
	assert.equal(
		applyProviderAwareSubagentModels(
			input,
			agents,
			primaryOnlyReasoningAvailable,
			"anthropic",
			undefined,
			{
				agentOverrides: new Map([["code-reviewer", { thinking: "high" }]]),
				onWarning: (warning) => warnings.push(warning.message),
			},
		),
		1,
	);
	assert.equal(input.model, "openai-codex/gpt-5.6-sol:high");
	assert.deepEqual(input.fallbackModels, ["custom/provider-model"]);
	assert.deepEqual(warnings, []);
});


test("subagent resolution reports independence state for bundled and overridden review models", () => {
	assert.equal(
		resolveProviderAwareSubagentResolution(
			codeReviewer,
			[...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
			"anthropic",
		).independence,
		"preferred",
	);
	assert.equal(
		resolveProviderAwareSubagentResolution(
			codeReviewer,
			reasoningAnthropicAvailable,
			"anthropic",
			undefined,
			{ model: "anthropic/claude-opus-4-8" },
		).independence,
		"degraded",
	);
});

test("provider-aware subagent mutation injects model but preserves caller-supplied fallback fields", () => {
	const available = [...anthropicAvailable, ...codexAvailable];

	// Caller supplies fallbackModels but no model → opposite-provider model is injected,
	// caller-provided fallbackModels kept, TLH auto-adds modelFallbackNotice.
	const withFallbackModels = { agent: "code-reviewer", fallbackModels: ["custom/provider-model"] };
	assert.equal(applyProviderAwareSubagentModels(withFallbackModels, agents, available, "anthropic"), 1);
	assert.equal(withFallbackModels.model, "openai-codex/gpt-5.6-sol");
	assert.deepEqual(withFallbackModels.fallbackModels, ["custom/provider-model"]);
	assert.equal(withFallbackModels.modelFallbackNotice, reducedIndependenceNotice);

	// Caller supplies modelFallbackNotice but no model → opposite-provider model is injected,
	// TLH auto-adds fallbackModels, caller-provided modelFallbackNotice kept.
	const withFallbackNotice = { agent: "oracle", modelFallbackNotice: "custom fallback notice" };
	assert.equal(applyProviderAwareSubagentModels(withFallbackNotice, agents, available, "openai-codex"), 1);
	assert.equal(withFallbackNotice.model, "anthropic/claude-opus-4-8");
	assert.deepEqual(withFallbackNotice.fallbackModels, ["openai-codex/gpt-5.6-sol"]);
	assert.equal(withFallbackNotice.modelFallbackNotice, "custom fallback notice");

	// Explicit model still prevents all injection regardless of other fallback fields.
	const withExplicitModel = { agent: "code-reviewer", model: "anthropic/claude-opus-4-8", fallbackModels: ["my/fallback"] };
	assert.equal(applyProviderAwareSubagentModels(withExplicitModel, agents, available, "anthropic"), 0);
	assert.equal(withExplicitModel.model, "anthropic/claude-opus-4-8");
	assert.deepEqual(withExplicitModel.fallbackModels, ["my/fallback"]);
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

test("provider-aware subagent mutation ignores legacy chain payloads", () => {
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

	assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 0);
	assert.equal(input.chain[0].model, undefined);
	assert.equal(input.chain[1].parallel[0].model, undefined);
	assert.equal(input.chain[1].parallel[1].model, "openai/gpt-5.4");
});
