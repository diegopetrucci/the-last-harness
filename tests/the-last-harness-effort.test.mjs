import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { registerEffortCommand } = await jiti.import("../extensions/the-last-harness/effort.ts");

// ---------------------------------------------------------------------------
// Minimal harness and helpers
// ---------------------------------------------------------------------------

function createPiHarness() {
	const commands = new Map();
	return {
		commands,
		thinkingLevel: "medium",
		registerCommand(name, options) {
			commands.set(name, options);
		},
		getThinkingLevel() {
			return this.thinkingLevel;
		},
		setThinkingLevel(level) {
			this.thinkingLevel = level;
		},
	};
}

function createFakeRuntime(agentPrompt) {
	return {
		activePrimaryAgentPrompt() {
			return agentPrompt;
		},
	};
}

/**
 * Creates a minimal ctx for the effort handler.
 * @param {object} opts
 * @param {string|undefined} opts.provider  model provider (e.g. "anthropic", "openai")
 * @param {object|undefined} opts.model     full model object — if given, overrides provider
 * @param {boolean}          opts.hasUI     whether the ctx has interactive UI (default: false)
 */
function createCtx({ provider, model, hasUI = false } = {}) {
	const notifications = [];
	const resolvedModel = model !== undefined ? model : provider ? { provider, id: "test-model" } : undefined;
	return {
		notifications,
		ctx: {
			model: resolvedModel,
			hasUI,
			ui: {
				notify(message, type = "info") {
					notifications.push({ message, type });
				},
				async select(_prompt, _options) {
					return null;
				},
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Agent-prompt factories matching actual frontmatter (T1)
// ---------------------------------------------------------------------------

function rushPrimary() {
	return {
		name: "rush",
		description: "Rush primary",
		model: "anthropic/claude-sonnet-4-6",
		tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
		thinking: "low",
		tlhOpenaiThinking: "medium",
		preferCurrentOpenaiModel: true,
		lockThinking: true,
		tools: [],
		systemPrompt: "rush",
		filePath: "agents/primary/rush.md",
	};
}

function productPrimary() {
	return {
		name: "product",
		description: "Product primary",
		model: "anthropic/claude-opus-5",
		thinking: "high",
		lockThinking: true,
		tools: [],
		systemPrompt: "product",
		filePath: "agents/primary/product.md",
	};
}

function bugHunterPrimary() {
	return {
		name: "bug-hunter",
		description: "Bug-hunter primary",
		model: "anthropic/claude-opus-5",
		thinking: "high",
		lockThinking: true,
		tools: [],
		systemPrompt: "bug-hunter",
		filePath: "agents/primary/bug-hunter.md",
	};
}

function architectPrimary() {
	return {
		name: "architect",
		description: "Architect primary",
		model: "anthropic/claude-opus-5",
		thinking: "high",
		minThinking: "medium",
		tools: [],
		systemPrompt: "architect",
		filePath: "agents/primary/architect.md",
	};
}

/** A reasoning model whose thinkingLevelMap supports xhigh and max. */
function reasoningModel(provider = "anthropic") {
	return { provider, id: "claude-opus-4-8", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
}

// ---------------------------------------------------------------------------
// 1. Locked primaries — rush, product, bug-hunter
// ---------------------------------------------------------------------------

test("getArgumentCompletions returns empty list for locked primary: rush", () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(rushPrimary()));
	const completions = pi.commands.get("effort").getArgumentCompletions("");
	assert.deepEqual(completions, []);
});

test("getArgumentCompletions returns empty list for locked primary: product", () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(productPrimary()));
	const completions = pi.commands.get("effort").getArgumentCompletions("");
	assert.deepEqual(completions, []);
});

test("getArgumentCompletions returns empty list for locked primary: bug-hunter", () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(bugHunterPrimary()));
	const completions = pi.commands.get("effort").getArgumentCompletions("");
	assert.deepEqual(completions, []);
});

test("getArgumentCompletions returns empty list for locked primary regardless of prefix", () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(rushPrimary()));
	const command = pi.commands.get("effort");
	assert.deepEqual(command.getArgumentCompletions("m"), []);
	assert.deepEqual(command.getArgumentCompletions("hi"), []);
});

test("handler errors with exact message for rush on anthropic (thinking: low)", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(rushPrimary()));
	const { notifications, ctx } = createCtx({ provider: "anthropic" });
	await pi.commands.get("effort").handler("low", ctx);
	assert.equal(notifications.length, 1);
	assert.deepEqual(notifications[0], {
		message: 'Thinking is locked at "low" for the rush primary agent.',
		type: "error",
	});
});

test("handler errors with 'medium' for rush on OpenAI", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(rushPrimary()));
	const { notifications, ctx } = createCtx({ provider: "openai" });
	await pi.commands.get("effort").handler("low", ctx);
	assert.equal(notifications.length, 1);
	assert.deepEqual(notifications[0], {
		message: 'Thinking is locked at "medium" for the rush primary agent.',
		type: "error",
	});
});

test("handler errors with 'medium' for rush on openai-codex provider", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(rushPrimary()));
	const { notifications, ctx } = createCtx({ provider: "openai-codex" });
	await pi.commands.get("effort").handler("high", ctx);
	assert.deepEqual(notifications[0], {
		message: 'Thinking is locked at "medium" for the rush primary agent.',
		type: "error",
	});
});

test("handler errors with exact message for product (thinking: high)", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(productPrimary()));
	const { notifications, ctx } = createCtx({ provider: "anthropic" });
	await pi.commands.get("effort").handler("low", ctx);
	assert.equal(notifications.length, 1);
	assert.deepEqual(notifications[0], {
		message: 'Thinking is locked at "high" for the product primary agent.',
		type: "error",
	});
});

test("handler errors with exact message for bug-hunter (thinking: high)", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(bugHunterPrimary()));
	const { notifications, ctx } = createCtx({ provider: "anthropic" });
	await pi.commands.get("effort").handler("off", ctx);
	assert.equal(notifications.length, 1);
	assert.deepEqual(notifications[0], {
		message: 'Thinking is locked at "high" for the bug-hunter primary agent.',
		type: "error",
	});
});

test("locked handler also fires with no args (handler called without a level)", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(rushPrimary()));
	const { notifications, ctx } = createCtx({ provider: "anthropic" });
	await pi.commands.get("effort").handler("", ctx);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "error");
	assert.match(notifications[0].message, /Thinking is locked at "low" for the rush primary agent\./);
});

// ---------------------------------------------------------------------------
// 2. minThinking floor — architect (minThinking: medium)
// ---------------------------------------------------------------------------

test("getArgumentCompletions for architect returns only medium/high/xhigh/max when no prefix", () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	const completions = pi.commands.get("effort").getArgumentCompletions("");
	assert.deepEqual(
		completions.map((c) => c.value),
		["medium", "high", "xhigh", "max"],
	);
});

test("getArgumentCompletions for architect filters correctly with prefix 'h'", () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	const completions = pi.commands.get("effort").getArgumentCompletions("h");
	assert.deepEqual(
		completions.map((c) => c.value),
		["high"],
	);
});

test("getArgumentCompletions for architect returns null for prefix below floor (not null vs empty)", () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	// "l" matches "low" but low is below the floor — nothing matches
	const completions = pi.commands.get("effort").getArgumentCompletions("l");
	assert.equal(completions, null);
});

test("architect handler accepts medium", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("medium", ctx);
	assert.equal(pi.thinkingLevel, "medium");
	assert.equal(notifications.at(-1)?.type, "info");
});

test("architect handler accepts high", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("high", ctx);
	assert.equal(pi.thinkingLevel, "high");
	assert.equal(notifications.at(-1)?.type, "info");
});

test("architect handler accepts xhigh when model supports it", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("xhigh", ctx);
	assert.equal(pi.thinkingLevel, "xhigh");
	assert.equal(notifications.at(-1)?.type, "info");
});

test("architect handler accepts max when model supports it", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("max", ctx);
	assert.equal(pi.thinkingLevel, "max");
	assert.equal(notifications.at(-1)?.type, "info");
});

test("architect handler rejects off with exact error message", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("off", ctx);
	assert.deepEqual(notifications.at(-1), {
		message: "architect requires at least medium thinking.",
		type: "error",
	});
});

test("architect handler rejects minimal with exact error message", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("minimal", ctx);
	assert.deepEqual(notifications.at(-1), {
		message: "architect requires at least medium thinking.",
		type: "error",
	});
});

test("architect handler rejects low with exact error message", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("low", ctx);
	assert.deepEqual(notifications.at(-1), {
		message: "architect requires at least medium thinking.",
		type: "error",
	});
});

test("architect handler does not change thinking level when rejecting a below-floor selection", async () => {
	const pi = createPiHarness();
	pi.thinkingLevel = "high";
	registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
	const { ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("off", ctx);
	// Level must be unchanged
	assert.equal(pi.thinkingLevel, "high");
});

// ---------------------------------------------------------------------------
// 3. Disabled primary (no active primary) — passthrough regression guard
// ---------------------------------------------------------------------------

test("getArgumentCompletions with no primary returns all thinking levels", () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(undefined));
	const completions = pi.commands.get("effort").getArgumentCompletions("");
	assert.deepEqual(
		completions.map((c) => c.value),
		["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	);
});

test("getArgumentCompletions with no primary filters by prefix normally", () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(undefined));
	const completions = pi.commands.get("effort").getArgumentCompletions("m");
	// THINKING_LEVELS order: off, minimal, low, medium, high, xhigh, max — so minimal precedes medium and max.
	assert.deepEqual(
		completions.map((c) => c.value),
		["minimal", "medium", "max"],
	);
});

test("disabled primary handler accepts off", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(undefined));
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("off", ctx);
	assert.equal(pi.thinkingLevel, "off");
	assert.equal(notifications.at(-1)?.type, "info");
});

test("disabled primary handler accepts medium", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(undefined));
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("medium", ctx);
	assert.equal(pi.thinkingLevel, "medium");
	assert.equal(notifications.at(-1)?.type, "info");
});

test("disabled primary handler accepts high", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi, createFakeRuntime(undefined));
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("high", ctx);
	assert.equal(pi.thinkingLevel, "high");
	assert.equal(notifications.at(-1)?.type, "info");
});

test("no runtime passed behaves identically to disabled primary (full completions)", () => {
	const pi = createPiHarness();
	registerEffortCommand(pi); // no runtime argument
	const completions = pi.commands.get("effort").getArgumentCompletions("");
	assert.deepEqual(
		completions.map((c) => c.value),
		["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	);
});

test("no runtime passed handler accepts any valid level", async () => {
	const pi = createPiHarness();
	registerEffortCommand(pi); // no runtime argument
	const { notifications, ctx } = createCtx({ model: reasoningModel() });
	await pi.commands.get("effort").handler("low", ctx);
	assert.equal(pi.thinkingLevel, "low");
	assert.equal(notifications.at(-1)?.type, "info");
});
