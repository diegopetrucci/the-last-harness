import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { InteractiveMode, ModelRegistry } from "@earendil-works/pi-coding-agent";
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
	const registry = Object.create(ModelRegistry.prototype);
	registry.models = models;
	registry.hasConfiguredAuth = () => true;
	registry.refresh = () => {};
	return registry;
}

function modelKeys(models) {
	return models.map((model) => `${model.provider}/${model.id}`);
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

	assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-opus-4-5" }, config), true);
	assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-opus-4-6" }, config), false);
	assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-haiku-4-5" }, config), false);
	assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-3-5-sonnet-20241022" }, config), true);
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

		assert.deepEqual(modelKeys(registry.getAvailable()), ["anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.5"]);
		assert.deepEqual(modelKeys(getUnfilteredAvailableModels(registry)), [
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-opus-4-6",
			"anthropic/claude-sonnet-4-6",
			"openai-codex/gpt-5.5",
		]);

		writeFileSync(
			settingsPath,
			`${JSON.stringify({ tlh: { modelVisibility: { hidden: ["anthropic/claude-sonnet-4-6"], unhide: ["claude-haiku-4-5"] } } }, null, 2)}\n`,
		);
		assert.deepEqual(modelKeys(registry.getAvailable()), ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.5"]);

		writeFileSync(settingsPath, `${JSON.stringify({ tlh: { modelVisibility: { disabled: true } } }, null, 2)}\n`);
		assert.deepEqual(modelKeys(registry.getAvailable()), [
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-opus-4-6",
			"anthropic/claude-sonnet-4-6",
			"openai-codex/gpt-5.5",
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

		assert.deepEqual(modelKeys(registry.getAvailable()), ["anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.5"]);
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

test("exact /model provider/model lookup can resolve hidden models without unfiltering normal availability", async (t) => {
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

		const interactiveMode = Object.create(InteractiveMode.prototype);
		interactiveMode.runtimeHost = { session: { scopedModels: [], modelRegistry: registry } };
		const hiddenExactMatch = await InteractiveMode.prototype.findExactModelMatch.call(
			interactiveMode,
			"anthropic/claude-opus-4-6",
		);
		assert.deepEqual(hiddenExactMatch, { provider: "anthropic", id: "claude-opus-4-6" });
		assert.equal(await InteractiveMode.prototype.findExactModelMatch.call(interactiveMode, "claude-opus-4-6"), undefined);
		assert.deepEqual(modelKeys(registry.getAvailable()), ["anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.5"]);

		interactiveMode.runtimeHost.session.scopedModels = [{ model: { provider: "anthropic", id: "claude-sonnet-4-6" } }];
		assert.equal(await InteractiveMode.prototype.findExactModelMatch.call(interactiveMode, "anthropic/claude-opus-4-6"), undefined);
	});
});
