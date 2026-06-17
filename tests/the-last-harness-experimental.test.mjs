import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const RETIRED_RUN_TESTS_LAST_FEATURE = "run-tests-last";
const LEGACY_UNKNOWN_FEATURE = "legacy-flag";
const jiti = createJiti(import.meta.url);
const {
	DELTA_FOLLOW_UP_REVIEWS_FEATURE,
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

test("experimental command registers the delta follow-up review flag and lists it as default-off", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		assert.deepEqual(
			(await command.getArgumentCompletions("enable ")).map((completion) => completion.value),
			[`enable ${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`],
		);
		assert.deepEqual(
			(await command.getArgumentCompletions("status ")).map((completion) => completion.value),
			["status", `status ${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`],
		);
		assert.equal(await command.getArgumentCompletions("unknown"), null);

		const { ctx, notifications } = createCommandContext(fixture.dir);
		await command.handler("", ctx);

		assert.equal(notifications.at(-1)?.type, "info");
		assert.match(notifications.at(-1)?.message ?? "", /TLH experimental features:/);
		assert.match(notifications.at(-1)?.message ?? "", /delta-follow-up-reviews/);
		assert.match(notifications.at(-1)?.message ?? "", /disabled \(default\)/);
		assert.match(notifications.at(-1)?.message ?? "", /\/experimental enable delta-follow-up-reviews/);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /run-tests-last/);
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
			assert.match(notifications.at(-1)?.message ?? "", /delta-follow-up-reviews/);
			assert.match(notifications.at(-1)?.message ?? "", /disabled \(default\)/);
			assert.doesNotMatch(notifications.at(-1)?.message ?? "", /run-tests-last/);

			({ ctx, notifications } = createCommandContext(fixture.dir));
			await command.handler(`status ${RETIRED_RUN_TESTS_LAST_FEATURE}`, ctx);
			assert.equal(notifications.at(-1)?.type, "info");
			assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
			assert.match(notifications.at(-1)?.message ?? "", /run-tests-last/);
			assert.match(notifications.at(-1)?.message ?? "", /delta-follow-up-reviews/);

			for (const action of ["enable", "disable", "toggle"]) {
				({ ctx, notifications } = createCommandContext(fixture.dir));
				await command.handler(`${action} ${RETIRED_RUN_TESTS_LAST_FEATURE}`, ctx);
				assert.equal(notifications.at(-1)?.type, "error");
				assert.match(
					notifications.at(-1)?.message ?? "",
					new RegExp(`Could not update TLH experimental feature ${RETIRED_RUN_TESTS_LAST_FEATURE}:`, "i"),
				);
				assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
			}

			assert.equal(readFileSync(settingsPath, "utf8"), malformedOrStaleSettings);
			assert.equal(buildPrimaryExperimentalPrompt({ name: "developer" }, getTlhExperimentalConfig(fixture.dir)), undefined);
		});
	}
});

test("experimental enable is idempotent, preserves settings, and does not clobber other enabled features", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const initialSettings = `${JSON.stringify(
		{ tlh: { primaryAgent: { selected: "architect" }, experimental: { enabledFeatures: [LEGACY_UNKNOWN_FEATURE] } } },
		null,
		2,
	)}\n`;
	writeFileSync(settingsPath, initialSettings);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler(`enable ${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`, ctx);

		const writtenAfterFirst = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(writtenAfterFirst.tlh.primaryAgent, { selected: "architect" });
		assert.deepEqual(writtenAfterFirst.tlh.experimental.enabledFeatures, [DELTA_FOLLOW_UP_REVIEWS_FEATURE, LEGACY_UNKNOWN_FEATURE]);
		assert.equal(isTlhExperimentalFeatureEnabled(getTlhExperimentalConfig(fixture.dir), DELTA_FOLLOW_UP_REVIEWS_FEATURE), true);
		assert.equal(isTlhExperimentalFeatureEnabled(getTlhExperimentalConfig(fixture.dir), RETIRED_RUN_TESTS_LAST_FEATURE), false);

		const backupsAfterFirst = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-"));
		assert.equal(backupsAfterFirst.length, 1);
		assert.equal(readFileSync(join(fixture.agent, backupsAfterFirst[0]), "utf8"), initialSettings);
		assert.match(notifications.at(-1)?.message ?? "", /Updated TLH experimental feature delta-follow-up-reviews/);
		assert.match(notifications.at(-1)?.message ?? "", /Undo with \/experimental disable delta-follow-up-reviews/);
		assert.match(notifications.at(-1)?.message ?? "", /Backup:/);

		await command.handler(`enable ${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`, ctx);

		assert.deepEqual(
			readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-")),
			backupsAfterFirst,
		);
		assert.match(notifications.at(-1)?.message ?? "", /No change to TLH experimental feature delta-follow-up-reviews/);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /Backup:/);
	});
});

test("experimental disable and normal-Pi refusal follow isolated settings rules", async (t) => {
	const disableFixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	const disableSettingsPath = join(disableFixture.agent, "settings.json");
	writeFileSync(
		disableSettingsPath,
		`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [DELTA_FOLLOW_UP_REVIEWS_FEATURE] } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: disableFixture.home, PI_CODING_AGENT_DIR: disableFixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		const { ctx, notifications } = createCommandContext(disableFixture.dir);

		await command.handler(`disable ${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`, ctx);

		const written = JSON.parse(readFileSync(disableSettingsPath, "utf8"));
		assert.deepEqual(written.tlh.experimental.enabledFeatures, []);
		assert.match(notifications.at(-1)?.message ?? "", /It is now disabled/);
		assert.match(notifications.at(-1)?.message ?? "", /Undo with \/experimental enable delta-follow-up-reviews/);
	});

	const normalFixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	const normalAgent = join(normalFixture.home, ".pi", "agent");

	await withEnv({ HOME: normalFixture.home, PI_CODING_AGENT_DIR: normalAgent }, async () => {
		const command = registeredExperimentalCommand();
		const { ctx, notifications } = createCommandContext(normalFixture.dir);

		await command.handler(`enable ${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`, ctx);

		assert.equal(existsSync(join(normalAgent, "settings.json")), false);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /isolated TLH profile|normal Pi config/);
	});
});

test("experimental retired flag actions do not create settings or backups on a fresh profile", async (t) => {
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
		assert.match(notifications.at(-1)?.message ?? "", /delta-follow-up-reviews/);
	});
});
