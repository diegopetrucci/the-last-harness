import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const RETIRED_RUN_TESTS_LAST_FEATURE = "run-tests-last";
const jiti = createJiti(import.meta.url);
const {
	buildPrimaryExperimentalPrompt,
	getTlhExperimentalConfig,
	isTlhExperimentalFeatureEnabled,
	registerExperimentalCommand,
} = await jiti.import("../extensions/the-last-harness/experimental.ts");

function createPiHarness() {
	const commands = new Map();
	return {
		commands,
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};
}

function createCommandContext(cwd) {
	const notifications = [];
	return {
		notifications,
		ctx: {
			cwd,
			ui: {
				notify(message, type = "info") {
					notifications.push({ message, type });
				},
			},
		},
	};
}

function registeredExperimentalCommand() {
	const pi = createPiHarness();
	registerExperimentalCommand(pi);
	const command = pi.commands.get("experimental");
	assert.ok(command, "registers /experimental");
	return command;
}

test("experimental command keeps an empty future-ready surface when no flags are registered", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		assert.deepEqual(
			(await command.getArgumentCompletions("")).map((completion) => completion.value),
			["list", "status"],
		);
		assert.deepEqual(
			(await command.getArgumentCompletions("status ")).map((completion) => completion.value),
			["status"],
		);
		assert.equal(await command.getArgumentCompletions("enable "), null);
		assert.equal(await command.getArgumentCompletions("disable "), null);
		assert.equal(await command.getArgumentCompletions("toggle "), null);

		const { ctx, notifications } = createCommandContext(fixture.dir);
		await command.handler("", ctx);

		assert.equal(notifications.at(-1)?.type, "info");
		assert.match(notifications.at(-1)?.message ?? "", /none currently registered/i);
		assert.match(notifications.at(-1)?.message ?? "", /future tlh feature flags/i);
	});
});

test("experimental stale settings fail closed and do not rebuild retired run-tests-last guidance", async (t) => {
	for (const enabledFeatures of [true, [123], [RETIRED_RUN_TESTS_LAST_FEATURE]]) {
		const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
		const settingsPath = join(fixture.agent, "settings.json");
		const malformedOrStaleSettings = `${JSON.stringify({ tlh: { experimental: { enabledFeatures } } }, null, 2)}\n`;
		writeFileSync(settingsPath, malformedOrStaleSettings);

		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			const command = registeredExperimentalCommand();
			assert.equal(
				isTlhExperimentalFeatureEnabled(getTlhExperimentalConfig(fixture.dir), RETIRED_RUN_TESTS_LAST_FEATURE),
				false,
			);
			assert.equal(
				buildPrimaryExperimentalPrompt({ name: "architect" }, getTlhExperimentalConfig(fixture.dir)),
				undefined,
			);

			let { ctx, notifications } = createCommandContext(fixture.dir);
			await command.handler("", ctx);
			assert.equal(notifications.at(-1)?.type, "info");
			assert.match(notifications.at(-1)?.message ?? "", /none currently registered/i);

			({ ctx, notifications } = createCommandContext(fixture.dir));
			await command.handler(`status ${RETIRED_RUN_TESTS_LAST_FEATURE}`, ctx);
			assert.equal(notifications.at(-1)?.type, "info");
			assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
			assert.match(notifications.at(-1)?.message ?? "", /run-tests-last/);
			assert.match(notifications.at(-1)?.message ?? "", /none currently registered/i);

			for (const action of ["enable", "disable", "toggle"]) {
				({ ctx, notifications } = createCommandContext(fixture.dir));
				await command.handler(`${action} ${RETIRED_RUN_TESTS_LAST_FEATURE}`, ctx);
				assert.equal(notifications.at(-1)?.type, "error");
				assert.match(notifications.at(-1)?.message ?? "", new RegExp(`Could not update TLH experimental feature ${RETIRED_RUN_TESTS_LAST_FEATURE}:`, "i"));
				assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
			}

			assert.equal(readFileSync(settingsPath, "utf8"), malformedOrStaleSettings);
			assert.equal(buildPrimaryExperimentalPrompt({ name: "developer" }, getTlhExperimentalConfig(fixture.dir)), undefined);
		});
	}
});

test("experimental retired flag actions do not create settings or backups on the empty surface", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler(`enable ${RETIRED_RUN_TESTS_LAST_FEATURE}`, ctx);

		assert.equal(existsSync(settingsPath), false);
		assert.deepEqual(
			readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-")),
			[],
		);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
		assert.match(notifications.at(-1)?.message ?? "", /none currently registered/i);
	});
});
