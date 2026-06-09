import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
	RUN_TESTS_LAST_FEATURE,
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
	assert.equal(pi.commands.has("experiments"), false);
	const command = pi.commands.get("experimental");
	assert.ok(command, "registers /experimental");
	return command;
}

test("experimental command registers completions and lists default-off feature state", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		assert.deepEqual(
			(await command.getArgumentCompletions("enable ")).map((completion) => completion.value),
			[`enable ${RUN_TESTS_LAST_FEATURE}`],
		);
		assert.deepEqual(
			(await command.getArgumentCompletions("status ")).map((completion) => completion.value),
			["status", `status ${RUN_TESTS_LAST_FEATURE}`],
		);
		assert.equal(await command.getArgumentCompletions("unknown"), null);

		const { ctx, notifications } = createCommandContext(fixture.dir);
		await command.handler("", ctx);

		assert.equal(notifications.at(-1)?.type, "info");
		assert.match(notifications.at(-1)?.message ?? "", /TLH experimental features:/);
		assert.match(notifications.at(-1)?.message ?? "", /disabled \(default\)/);
		assert.match(notifications.at(-1)?.message ?? "", /\/experimental enable run-tests-last/);
	});
});

test("experimental read paths fail closed on malformed enabledFeatures while writes still validate clearly", async (t) => {
	for (const { enabledFeatures, expectedError } of [
		{ enabledFeatures: true, expectedError: /must be an array if present/ },
		{ enabledFeatures: [123], expectedError: /must contain only strings/ },
	]) {
		const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
		const settingsPath = join(fixture.agent, "settings.json");
		const malformedSettings = `${JSON.stringify({ tlh: { experimental: { enabledFeatures } } }, null, 2)}\n`;
		writeFileSync(settingsPath, malformedSettings);

		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			const command = registeredExperimentalCommand();

			assert.equal(isTlhExperimentalFeatureEnabled(getTlhExperimentalConfig(fixture.dir), RUN_TESTS_LAST_FEATURE), false);

			let { ctx, notifications } = createCommandContext(fixture.dir);
			await command.handler("", ctx);
			assert.equal(notifications.at(-1)?.type, "info");
			assert.match(notifications.at(-1)?.message ?? "", /disabled \(default\)/);

			({ ctx, notifications } = createCommandContext(fixture.dir));
			await command.handler(`status ${RUN_TESTS_LAST_FEATURE}`, ctx);
			assert.equal(notifications.at(-1)?.type, "info");
			assert.match(notifications.at(-1)?.message ?? "", /disabled \(default\)/);

			({ ctx, notifications } = createCommandContext(fixture.dir));
			await command.handler(`enable ${RUN_TESTS_LAST_FEATURE}`, ctx);
			assert.equal(notifications.at(-1)?.type, "error");
			assert.match(notifications.at(-1)?.message ?? "", /Could not update TLH experimental feature run-tests-last:/);
			assert.match(notifications.at(-1)?.message ?? "", expectedError);
			assert.equal(readFileSync(settingsPath, "utf8"), malformedSettings);
		});
	}
});

test("experimental enable is idempotent, preserves settings, and creates one backup", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const initialSettings = `${JSON.stringify({ tlh: { primaryAgent: { selected: "architect" } } }, null, 2)}\n`;
	writeFileSync(settingsPath, initialSettings);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler(`enable ${RUN_TESTS_LAST_FEATURE}`, ctx);

		const writtenAfterFirst = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(writtenAfterFirst.tlh.primaryAgent, { selected: "architect" });
		assert.deepEqual(writtenAfterFirst.tlh.experimental.enabledFeatures, [RUN_TESTS_LAST_FEATURE]);
		assert.equal(isTlhExperimentalFeatureEnabled(getTlhExperimentalConfig(fixture.dir), RUN_TESTS_LAST_FEATURE), true);

		const backupsAfterFirst = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-"));
		assert.equal(backupsAfterFirst.length, 1);
		assert.equal(readFileSync(join(fixture.agent, backupsAfterFirst[0]), "utf8"), initialSettings);
		assert.match(notifications.at(-1)?.message ?? "", /Updated TLH experimental feature run-tests-last/);
		assert.match(notifications.at(-1)?.message ?? "", /Undo with \/experimental disable run-tests-last/);
		assert.match(notifications.at(-1)?.message ?? "", /Backup:/);

		await command.handler(`enable ${RUN_TESTS_LAST_FEATURE}`, ctx);

		assert.deepEqual(
			readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-")),
			backupsAfterFirst,
		);
		assert.match(notifications.at(-1)?.message ?? "", /No change to TLH experimental feature run-tests-last/);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /Backup:/);
	});
});

test("experimental disable and normal-Pi refusal follow isolated settings rules", async (t) => {
	const disableFixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	const disableSettingsPath = join(disableFixture.agent, "settings.json");
	writeFileSync(
		disableSettingsPath,
		`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [RUN_TESTS_LAST_FEATURE] } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: disableFixture.home, PI_CODING_AGENT_DIR: disableFixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		const { ctx, notifications } = createCommandContext(disableFixture.dir);

		await command.handler(`disable ${RUN_TESTS_LAST_FEATURE}`, ctx);

		const written = JSON.parse(readFileSync(disableSettingsPath, "utf8"));
		assert.deepEqual(written.tlh.experimental.enabledFeatures, []);
		assert.match(notifications.at(-1)?.message ?? "", /It is now disabled/);
		assert.match(notifications.at(-1)?.message ?? "", /Undo with \/experimental enable run-tests-last/);
	});

	const normalFixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	const normalAgent = join(normalFixture.home, ".pi", "agent");
	mkdirSync(normalAgent, { recursive: true });

	await withEnv({ HOME: normalFixture.home, PI_CODING_AGENT_DIR: normalAgent }, async () => {
		const command = registeredExperimentalCommand();
		const { ctx, notifications } = createCommandContext(normalFixture.dir);

		await command.handler(`enable ${RUN_TESTS_LAST_FEATURE}`, ctx);

		assert.equal(existsSync(join(normalAgent, "settings.json")), false);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /isolated TLH profile|normal Pi config/);
	});
});
