import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { InteractiveMode, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
	TLH_HIDDEN_MODEL_DEFAULTS,
	getTlhModelVisibilityConfig,
	getUnfilteredAvailableModels,
	installTlhModelVisibilityFilter,
	isTlhModelHidden,
	matchesTlhModelVisibilityPattern,
	normalizeTlhModelVisibilityConfig,
} = await jiti.import("../extensions/the-last-harness/model-visibility.ts");

function createFakeModelRegistry(models) {
	const runtime = {
		getModels: () => models,
		getAvailableSnapshot: () => models,
		getModel: (provider, modelId) => models.find((model) => model.provider === provider && model.id === modelId),
		hasConfiguredAuth: () => true,
		reloadConfig: async () => {},
		getError: () => undefined,
	};
	return new ModelRegistry(runtime);
}

function modelKeys(models) {
	return models.map((model) => `${model.provider}/${model.id}`);
}

function runtimeModel(id) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

async function createTestModelRuntime(models, refreshModels) {
	const runtime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
	runtime.registerProvider("tlh-test", {
		baseUrl: "https://tlh-test.example.invalid/v1",
		apiKey: "test-only",
		api: "openai-completions",
		models: models.map(runtimeModel),
		...(refreshModels ? { refreshModels: async () => refreshModels().map(runtimeModel) } : {}),
	});
	return runtime;
}

test("hidden model defaults stay pinned to the approved ordered list", () => {
	assert.deepEqual(TLH_HIDDEN_MODEL_DEFAULTS, [
		"anthropic/claude-3-5-haiku-20241022",
		"anthropic/claude-3-5-haiku-latest",
		"anthropic/claude-3-5-sonnet-20240620",
		"anthropic/claude-3-5-sonnet-20241022",
		"anthropic/claude-3-7-sonnet-20250219",
		"anthropic/claude-3-haiku-20240307",
		"anthropic/claude-3-opus-20240229",
		"anthropic/claude-3-sonnet-20240229",
		"anthropic/claude-haiku-4-5",
		"anthropic/claude-haiku-4-5-20251001",
		"anthropic/claude-opus-4-0",
		"anthropic/claude-opus-4-1",
		"anthropic/claude-opus-4-1-20250805",
		"anthropic/claude-opus-4-20250514",
		"anthropic/claude-opus-4-5",
		"anthropic/claude-opus-4-5-20251101",
		"anthropic/claude-opus-4-6",
		"anthropic/claude-sonnet-4-0",
		"anthropic/claude-sonnet-4-20250514",
		"anthropic/claude-sonnet-4-5",
		"anthropic/claude-sonnet-4-5-20250929",
		"anthropic/claude-sonnet-4-6",
		"anthropic/claude-sonnet-5",
		"openai-codex/gpt-5.3-codex-spark",
		"openai-codex/gpt-5.4",
		"openai-codex/gpt-5.4-mini",
	]);
});

test("model visibility matches canonical and bare-id glob patterns with visible overrides", () => {
	const config = normalizeTlhModelVisibilityConfig({
		hidden: ["anthropic/claude-opus-4-*", "claude-3-5-sonnet-*"],
		visible: ["anthropic/claude-opus-4-6"],
		unhide: ["claude-haiku-4-5"],
	});

	assert.equal(matchesTlhModelVisibilityPattern({ provider: "anthropic", id: "claude-opus-4-5" }, "anthropic/claude-opus-4-*"), true);
	assert.equal(matchesTlhModelVisibilityPattern({ provider: "anthropic", id: "claude-opus-4-5" }, "claude-opus-4-*"), true);
	assert.equal(matchesTlhModelVisibilityPattern({ provider: "openai-codex", id: "gpt-5.5" }, "claude-opus-4-*"), false);

	const defaultsOnlyConfig = normalizeTlhModelVisibilityConfig({});

	assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-opus-4-5" }, config), true);
	assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-opus-4-6" }, config), false);
	assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-haiku-4-5" }, config), false);
	assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-3-5-sonnet-20241022" }, config), true);
	assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-sonnet-4-6" }, defaultsOnlyConfig), true);
	assert.equal(isTlhModelHidden({ provider: "openai-codex", id: "gpt-5.4" }, defaultsOnlyConfig), true);
});

test("model visibility settings are isolated-profile only and normalize hidden/visible arrays", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(
		settingsPath,
		`${JSON.stringify({
			tlh: {
				modelVisibility: {
					disabled: true,
					hidden: [" anthropic/claude-opus-4-* ", 42, ""],
					visible: ["anthropic/claude-opus-4-6", false],
					unhide: [" claude-haiku-4-5 ", null],
				},
			},
		}, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		assert.deepEqual(getTlhModelVisibilityConfig(), {
			disabled: true,
			hidden: ["anthropic/claude-opus-4-*"],
			visible: ["anthropic/claude-opus-4-6", "claude-haiku-4-5"],
		});
	});

	const normalPiAgent = join(fixture.home, ".pi", "agent");
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: normalPiAgent }, async () => {
		assert.equal(getTlhModelVisibilityConfig().disabled, true);
	});
});

test("installed model visibility filter is idempotent, hides defaults, and preserves an unfiltered internal escape hatch", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const registry = createFakeModelRegistry([
		{ provider: "anthropic", id: "claude-haiku-4-5" },
		{ provider: "anthropic", id: "claude-opus-4-6" },
		{ provider: "anthropic", id: "claude-sonnet-4-6" },
		{ provider: "openai-codex", id: "gpt-5.4" },
		{ provider: "openai-codex", id: "gpt-5.5" },
	]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(settingsPath, `${JSON.stringify({}, null, 2)}\n`);

		installTlhModelVisibilityFilter();
		const patchedGetAvailable = ModelRegistry.prototype.getAvailable;
		const patchedFindExactModelMatch = InteractiveMode.prototype.findExactModelMatch;
		installTlhModelVisibilityFilter();
		assert.equal(ModelRegistry.prototype.getAvailable, patchedGetAvailable);
		assert.equal(InteractiveMode.prototype.findExactModelMatch, patchedFindExactModelMatch);

		assert.deepEqual(modelKeys(registry.getAvailable()), ["openai-codex/gpt-5.5"]);
		assert.deepEqual(modelKeys(getUnfilteredAvailableModels(registry)), [
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-opus-4-6",
			"anthropic/claude-sonnet-4-6",
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.5",
		]);

		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{
					tlh: {
						modelVisibility: {
							hidden: ["anthropic/claude-opus-4-6"],
							unhide: ["claude-haiku-4-5", "anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.4"],
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		assert.deepEqual(modelKeys(registry.getAvailable()), [
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-sonnet-4-6",
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.5",
		]);

		writeFileSync(settingsPath, `${JSON.stringify({ tlh: { modelVisibility: { disabled: true } } }, null, 2)}\n`);
		assert.deepEqual(modelKeys(registry.getAvailable()), [
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-opus-4-6",
			"anthropic/claude-sonnet-4-6",
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.5",
		]);
	});
});

test("ModelRuntime filters async availability and current/refreshed snapshots while preserving the unfiltered escape hatch", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	let refreshedModels = ["hidden-refreshed", "visible-refreshed"];

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify({ tlh: { modelVisibility: { hidden: ["tlh-test/hidden-*"] } } }, null, 2)}\n`,
		);
		installTlhModelVisibilityFilter();
		const patchedGetAvailable = ModelRuntime.prototype.getAvailable;
		const patchedGetAvailableSnapshot = ModelRuntime.prototype.getAvailableSnapshot;
		installTlhModelVisibilityFilter();
		assert.equal(ModelRuntime.prototype.getAvailable, patchedGetAvailable);
		assert.equal(ModelRuntime.prototype.getAvailableSnapshot, patchedGetAvailableSnapshot);

		const runtime = await createTestModelRuntime(
			["hidden-current", "visible-current"],
			() => refreshedModels,
		);
		const registry = new ModelRegistry(runtime);

		assert.deepEqual(modelKeys(runtime.getAvailableSnapshot()).filter((key) => key.startsWith("tlh-test/")), ["tlh-test/visible-current"]);
		assert.deepEqual(modelKeys(await runtime.getAvailable("tlh-test")), ["tlh-test/visible-current"]);
		assert.deepEqual(modelKeys(registry.getAvailable()).filter((key) => key.startsWith("tlh-test/")), ["tlh-test/visible-current"]);
		assert.deepEqual(modelKeys(getUnfilteredAvailableModels(runtime)).filter((key) => key.startsWith("tlh-test/")), [
			"tlh-test/hidden-current",
			"tlh-test/visible-current",
		]);
		assert.deepEqual(modelKeys(getUnfilteredAvailableModels(registry)).filter((key) => key.startsWith("tlh-test/")), [
			"tlh-test/hidden-current",
			"tlh-test/visible-current",
		]);

		refreshedModels = ["hidden-after-refresh", "visible-after-refresh"];
		await runtime.refresh({ allowNetwork: false, force: true });
		assert.deepEqual(modelKeys(runtime.getAvailableSnapshot()).filter((key) => key.startsWith("tlh-test/")), ["tlh-test/visible-after-refresh"]);
		assert.deepEqual(modelKeys(await runtime.getAvailable("tlh-test")), ["tlh-test/visible-after-refresh"]);
		assert.deepEqual(modelKeys(getUnfilteredAvailableModels(registry)).filter((key) => key.startsWith("tlh-test/")), [
			"tlh-test/hidden-after-refresh",
			"tlh-test/visible-after-refresh",
		]);
	});
});

test("installed model visibility filter keeps getAll direct lookup unfiltered while getAvailable stays filtered", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const registry = createFakeModelRegistry([
		{ provider: "anthropic", id: "claude-opus-4-6" },
		{ provider: "anthropic", id: "claude-sonnet-4-6" },
		{ provider: "openai-codex", id: "gpt-5.5" },
	]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(settingsPath, `${JSON.stringify({}, null, 2)}\n`);
		installTlhModelVisibilityFilter();

		assert.deepEqual(modelKeys(registry.getAvailable()), ["openai-codex/gpt-5.5"]);
		assert.deepEqual(modelKeys(registry.getAll()), [
			"anthropic/claude-opus-4-6",
			"anthropic/claude-sonnet-4-6",
			"openai-codex/gpt-5.5",
		]);
		assert.deepEqual(
			registry.getAll().find((model) => `${model.provider}/${model.id}` === "anthropic/claude-opus-4-6"),
			{ provider: "anthropic", id: "claude-opus-4-6" },
		);
	});
});

test("exact /model provider/model lookup uses the unfiltered ModelRuntime snapshot without bypassing scoped models", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify({ tlh: { modelVisibility: { hidden: ["tlh-test/hidden-*"] } } }, null, 2)}\n`,
		);
		installTlhModelVisibilityFilter();
		const runtime = await createTestModelRuntime(["hidden-exact", "hidden-scoped", "visible"]);
		const registry = new ModelRegistry(runtime);
		const interactiveMode = Object.create(InteractiveMode.prototype);
		interactiveMode.runtimeHost = {
			session: {
				scopedModels: [],
				modelRegistry: registry,
				modelRuntime: runtime,
			},
		};

		const hiddenExactMatch = await InteractiveMode.prototype.findExactModelMatch.call(
			interactiveMode,
			"tlh-test/hidden-exact",
		);
		assert.equal(`${hiddenExactMatch?.provider}/${hiddenExactMatch?.id}`, "tlh-test/hidden-exact");
		assert.equal(await InteractiveMode.prototype.findExactModelMatch.call(interactiveMode, "hidden-exact"), undefined);
		assert.deepEqual(modelKeys(runtime.getAvailableSnapshot()).filter((key) => key.startsWith("tlh-test/")), ["tlh-test/visible"]);

		interactiveMode.runtimeHost.session.scopedModels = [
			{ model: runtime.getModel("tlh-test", "hidden-scoped") },
		];
		assert.equal(await InteractiveMode.prototype.findExactModelMatch.call(interactiveMode, "tlh-test/hidden-exact"), undefined);
		const scopedMatch = await InteractiveMode.prototype.findExactModelMatch.call(interactiveMode, "tlh-test/hidden-scoped");
		assert.equal(`${scopedMatch?.provider}/${scopedMatch?.id}`, "tlh-test/hidden-scoped");
	});
});
