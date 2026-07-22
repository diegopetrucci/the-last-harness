import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { cleanupTempDir, createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
	registerTlhPrimaryAgentRuntime,
	createPiHarness,
	registerRuntimeHarness,
	writePrimaryConfig,
	createPrimaryPrompt,
	rushLikePrimary,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

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
				modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
				model: { provider: "openai-codex", id: "gpt-5.4" },
			});

			assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
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

test("architect before_agent_start preserves medium floor selection but restores declared default after rush", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const architectPrimary = createPrimaryPrompt("architect", {
		model: "anthropic/claude-opus-4-8",
		thinking: "high",
		minThinking: "medium",
		applyModel: true,
		applyThinking: true,
	});
	const rushPrimary = createPrimaryPrompt("rush", {
		model: "anthropic/claude-opus-4-8",
		thinking: "low",
		applyModel: true,
		applyThinking: true,
		lockThinking: true,
	});
	const primaryAgents = new Map([
		["architect", architectPrimary],
		["rush", rushPrimary],
	]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		assert.ok(runtime, "runtime should register outside child sessions");

		const makeCtx = (branch) => ({
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => branch },
			ui: { notify() {} },
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: { provider: "anthropic", id: "claude-opus-4-8" },
		});

		await runtime.applySessionStart(makeCtx([]));
		assert.equal(pi.thinkingLevel, "high", "architect starts at its declared default");

		pi.thinkingLevel = "medium";
		await beforeAgentStart({ systemPrompt: "base prompt" }, makeCtx([]));
		assert.equal(pi.thinkingLevel, "medium", "before_agent_start preserves a current level that satisfies architect's floor");

		await beforeAgentStart(
			{ systemPrompt: "base prompt" },
			makeCtx([{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } }]),
		);
		assert.equal(pi.thinkingLevel, "low", "locked rush still forces low thinking");

		await beforeAgentStart({ systemPrompt: "base prompt" }, makeCtx([]));
		assert.equal(pi.thinkingLevel, "high", "architect restores its declared default after returning from rush");
	});
});

test("primary runtime applies a max thinking default", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const architectPrimary = createPrimaryPrompt("architect", {
		model: "anthropic/claude-opus-4-8",
		thinking: "max",
		applyModel: true,
		applyThinking: true,
	});
	const primaryAgents = new Map([["architect", architectPrimary]]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		assert.ok(runtime, "runtime should register outside child sessions");

		const makeCtx = (branch) => ({
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => branch },
			ui: { notify() {} },
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: { provider: "anthropic", id: "claude-opus-4-8" },
		});

		await runtime.applySessionStart(makeCtx([]));
		assert.equal(pi.thinkingLevel, "max");

		pi.thinkingLevel = "off";
		await beforeAgentStart({ systemPrompt: "base prompt" }, makeCtx([]));
		assert.equal(pi.thinkingLevel, "max");
	});
});

test("locked primary (rush) overrides global applyThinking=false and applyModel=false", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const rushPrimary = createPrimaryPrompt("rush", {
		model: "anthropic/claude-opus-4-8",
		thinking: "low",
		applyModel: true,
		applyThinking: true,
		lockThinking: true,
	});
	const primaryAgents = new Map([["rush", rushPrimary]]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		// Global opt-outs that the lock should override
		writePrimaryConfig(fixture.agent, { applyModel: false, applyThinking: false });

		const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		assert.ok(runtime, "runtime should register outside child sessions");

		// Use a different initial model so applyPrimaryModel actually calls setModel
		await runtime.applySessionStart({
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => [
				{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
			]},
			ui: { notify() {} },
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: { provider: "anthropic", id: "claude-opus-4-6" },
		});

		// lockThinking: true forces both model and thinking regardless of global opt-outs
		assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
		assert.equal(pi.thinkingLevel, "low");
	});
});

test("non-locked primary (architect) honors global applyThinking=false override", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const architectPrimary = createPrimaryPrompt("architect", {
		model: "anthropic/claude-opus-4-8",
		thinking: "high",
		applyModel: true,
		applyThinking: true,
		// no lockThinking
	});
	const primaryAgents = new Map([["architect", architectPrimary]]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		// User opts out of thinking auto-apply for architect
		writePrimaryConfig(fixture.agent, { applyThinking: false });

		const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		assert.ok(runtime, "runtime should register outside child sessions");

		await runtime.applySessionStart({
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => [] },
			ui: { notify() {} },
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: { provider: "anthropic", id: "claude-opus-4-8" },
		});

		// Global applyThinking: false is respected for non-locked primary
		assert.equal(pi.thinkingLevel, "normal");
	});
});

// --- tlh-3mb3: per-primary model override tests ---

function createPiHarnessWithFiringModelSelect(getCtx) {
	const pi = createPiHarness();
	const modelSelectHandlers = [];
	const origOn = pi.on.bind(pi);
	pi.on = function (name, handler) {
		origOn(name, handler);
		if (name === "model_select") {
			modelSelectHandlers.push(handler);
		}
	};
	pi.setModel = async function (model) {
		const previousModel = this.model;
		this.model = model;
		const ctx = getCtx();
		if (ctx) {
			for (const h of modelSelectHandlers) {
				await h({ type: "model_select", model, previousModel, source: "set" }, ctx);
			}
		}
		return true;
	};
	return pi;
}

test("model override resolution: stored override is applied when the model is in the registry", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);
	// Bundled default for rushLikePrimary on Anthropic is anthropic/claude-opus-4-8.
	// Store a different available Anthropic model so override precedence is observable.
	const initialSettings = JSON.stringify({
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	}, null, 2) + "\n";

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
		const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		assert.ok(runtime);

		await runtime.applySessionStart({
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => [] },
			ui: { notify() {} },
			modelRegistry: {
				getAvailable: () => [
					{ provider: "anthropic", id: "claude-opus-4-8" },
					{ provider: "anthropic", id: "claude-sonnet-4-6" },
				],
			},
			model: { provider: "anthropic", id: "claude-haiku-4-5" },
		});

		// Override should win over the bundled anthropic/claude-opus-4-8 default.
		assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-sonnet-4-6" });
	});
});

test("model override resolution: falls back to bundled default when override model is unavailable", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);
	const initialSettings = JSON.stringify({
		tlh: { primaryAgent: { modelOverrides: { architect: "openai-codex/gpt-5.5" } } },
	}, null, 2) + "\n";

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
		const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		assert.ok(runtime);

		await runtime.applySessionStart({
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => [] },
			ui: { notify() {} },
			// Override model (openai-codex/gpt-5.5) is NOT in the registry
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: { provider: "anthropic", id: "claude-sonnet-4-6" },
		});

		// Falls back to bundled Anthropic default
		assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
	});
});

test("model_select listener writes override to settings when user picks a non-default model", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);
	// rushLikePrimary has model: "anthropic/claude-opus-4-8".
	// The user picks a different Anthropic model that is NOT the bundled default for the architect primary.
	// Available: both claude-opus-4-8 (bundled default) and claude-sonnet-4-6 (non-default).

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
		assert.ok(modelSelectHandler, "model_select handler must be registered");

		// User picks a non-default model: anthropic/claude-sonnet-4-6
		const overrideModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
		const ctx = {
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => [] },
			ui: { notify() {} },
			// Registry includes the bundled default (claude-opus-4-8) and the override target (claude-sonnet-4-6)
			modelRegistry: {
				getAvailable: () => [
					{ provider: "anthropic", id: "claude-opus-4-8" },
					{ provider: "anthropic", id: "claude-sonnet-4-6" },
				],
			},
			model: overrideModel,
		};
		// bundledKey for provider "anthropic" with rushLikePrimary: "anthropic/claude-opus-4-8" (the primary's .model field)
		// chosenKey: "anthropic/claude-sonnet-4-6" → different → should write override
		await modelSelectHandler(
			{ type: "model_select", model: overrideModel, previousModel: undefined, source: "set" },
			ctx,
		);

		const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		assert.equal(written.tlh.primaryAgent.modelOverrides.architect, "anthropic/claude-sonnet-4-6");
	});
});

test("model_select listener clears override when user reselects the primary's bundled default model", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);
	const initialSettings = JSON.stringify({
		tlh: { primaryAgent: { modelOverrides: { architect: "openai-codex/gpt-5.5" } } },
	}, null, 2) + "\n";

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
		const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
		assert.ok(modelSelectHandler, "model_select handler must be registered");

		// rushLikePrimary with only anthropic available: bundled default is anthropic/claude-opus-4-8
		const bundledDefaultModel = { provider: "anthropic", id: "claude-opus-4-8" };
		const ctx = {
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => [] },
			ui: { notify() {} },
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: bundledDefaultModel,
		};
		await modelSelectHandler(
			{ type: "model_select", model: bundledDefaultModel, previousModel: undefined, source: "set" },
			ctx,
		);

		const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		// Override for architect should be cleared
		assert.equal(written.tlh?.primaryAgent?.modelOverrides?.architect, undefined);
	});
});

test("locked primary does not write model override when model_select fires for a non-default user model", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	// rush has lockThinking: true → shouldForceApplyForLock returns true → listener must skip override.
	const lockedRush = createPrimaryPrompt("rush", {
		model: "anthropic/claude-opus-4-8",
		tlhOpenaiModels: ["openai-codex/gpt-5.5"],
		thinking: "low",
		applyModel: true,
		applyThinking: true,
		lockThinking: true,
	});
	const primaryAgents = new Map([["rush", lockedRush]]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
		assert.ok(modelSelectHandler, "model_select handler must be registered");

		const nonDefaultModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
		const ctx = {
			cwd: fixture.cwd,
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
				],
			},
			ui: { notify() {} },
			modelRegistry: {
				getAvailable: () => [
					{ provider: "anthropic", id: "claude-opus-4-8" },
					{ provider: "anthropic", id: "claude-sonnet-4-6" },
				],
			},
			model: nonDefaultModel,
		};
		await modelSelectHandler(
			{ type: "model_select", model: nonDefaultModel, previousModel: undefined, source: "set" },
			ctx,
		);

		// settings.json must NOT have been written — locked primaries never persist overrides
		let settings;
		try {
			settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		} catch {
			settings = null;
		}
		assert.equal(
			settings?.tlh?.primaryAgent?.modelOverrides?.rush,
			undefined,
			"locked primary (rush) must not record a model override",
		);
	});
});

test("echo guard: TLH's own applyPrimaryModel does not record a model override", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);
	let capturedCtx = null;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarnessWithFiringModelSelect(() => capturedCtx);
		const runtime = registerTlhPrimaryAgentRuntime(pi, { env: {}, primaryAgents, subagentMetadata: [] });
		assert.ok(runtime);

		const applyCtx = {
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => [] },
			ui: { notify() {} },
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: { provider: "anthropic", id: "claude-sonnet-4-6" }, // different from bundled default
		};
		capturedCtx = applyCtx;

		// This will call pi.setModel which fires model_select with source="set".
		// The echo guard (tlhApplyingModel=true) must suppress writing the override.
		await runtime.applySessionStart(applyCtx);

		// settings.json should NOT have been written (no override)
		let settings;
		try {
			settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		} catch {
			settings = null;
		}
		const overrides = settings?.tlh?.primaryAgent?.modelOverrides;
		assert.equal(overrides?.architect, undefined, "TLH's own setModel must not record a model override");
	});
});
