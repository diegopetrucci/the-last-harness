import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerUsageCommand, shouldShowTlhUsageWeekly } = await jiti.import("../extensions/the-last-harness/usage-limits.ts");

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

function registeredUsageCommand() {
	const pi = createPiHarness();
	registerUsageCommand(pi);
	const command = pi.commands.get("usage");
	assert.ok(command, "registers /usage");
	return command;
}

test("usage command registers completions and reports weekly auto mode by default", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-usage-limits-test-", { test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredUsageCommand();
		assert.deepEqual(
			(await command.getArgumentCompletions("weekly ")).map((completion) => completion.value),
			["weekly on", "weekly off", "weekly toggle"],
		);
		assert.deepEqual(
			(await command.getArgumentCompletions("status")).map((completion) => completion.value),
			["status"],
		);
		assert.equal(await command.getArgumentCompletions("unknown"), null);

		const { ctx, notifications } = createCommandContext(fixture.dir);
		await command.handler("", ctx);
		assert.equal(notifications.at(-1)?.type, "info");
		assert.match(notifications.at(-1)?.message ?? "", /default auto mode/);
		assert.match(notifications.at(-1)?.message ?? "", /below 25%/);
		assert.match(notifications.at(-1)?.message ?? "", /\/usage weekly on/);
		assert.match(notifications.at(-1)?.message ?? "", /\/usage weekly off/);
	});
});

test("usage weekly preference writes isolated settings and backs up existing settings", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-usage-limits-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const initialSettings = `${JSON.stringify({ tlh: { gnosis: { enabled: true } } }, null, 2)}\n`;
	writeFileSync(settingsPath, initialSettings);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredUsageCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler("weekly on", ctx);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(written.tlh.gnosis.enabled, true);
		assert.equal(written.tlh.usageLimits.showWeekly, true);
		assert.equal(shouldShowTlhUsageWeekly(written.tlh.usageLimits), true);

		const backups = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-"));
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(join(fixture.agent, backups[0]), "utf8"), initialSettings);

		const notice = notifications.at(-1);
		assert.equal(notice?.type, "info");
		assert.match(notice?.message ?? "", /shown/);
		assert.match(notice?.message ?? "", /\/usage weekly off/);
		assert.match(notice?.message ?? "", /Backup:/);
	});
});

test("usage weekly on is idempotent across repeated invocations", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-usage-limits-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify({ tlh: { gnosis: { enabled: true } } }, null, 2)}\n`);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredUsageCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler("weekly on", ctx);

		const afterFirst = readFileSync(settingsPath);
		const writtenAfterFirst = JSON.parse(afterFirst.toString("utf8"));
		assert.equal(writtenAfterFirst.tlh.usageLimits.showWeekly, true);

		const backupsAfterFirst = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-"));
		assert.equal(backupsAfterFirst.length, 1, "first call must create exactly one backup");

		const firstNotice = notifications.at(-1);
		assert.equal(firstNotice?.type, "info");
		assert.match(firstNotice?.message ?? "", /^Updated TLH usage weekly-window preference at /);

		await command.handler("weekly on", ctx);

		const afterSecond = readFileSync(settingsPath);
		assert.ok(afterSecond.equals(afterFirst), "settings file must be byte-identical after the second call");

		const backupsAfterSecond = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-"));
		assert.deepEqual(backupsAfterSecond, backupsAfterFirst, "no additional backup should be produced on the second call");

		const secondNotice = notifications.at(-1);
		assert.equal(secondNotice?.type, "info");
		assert.match(secondNotice?.message ?? "", /^No change to TLH usage weekly-window preference at /);
		assert.doesNotMatch(secondNotice?.message ?? "", /Backup:/);
	});
});

test("usage weekly on skips backups for empty existing settings files", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-usage-limits-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(settingsPath, "");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredUsageCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler("weekly on", ctx);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(written.tlh.usageLimits.showWeekly, true);
		assert.deepEqual(
			readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-")),
			[],
			"empty-string settings content must not produce a backup",
		);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /Backup:/);
	});
});

test("usage weekly off and toggle persist explicit preferences", async (t) => {
	const offFixture = createIsolatedProfileFixture("tlh-usage-limits-test-", { test: t });
	const offSettingsPath = join(offFixture.agent, "settings.json");
	writeFileSync(offSettingsPath, `${JSON.stringify({ tlh: { usageLimits: { showWeekly: true } } }, null, 2)}\n`);

	await withEnv({ HOME: offFixture.home, PI_CODING_AGENT_DIR: offFixture.agent }, async () => {
		const command = registeredUsageCommand();
		const { ctx, notifications } = createCommandContext(offFixture.dir);

		await command.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /shown/);

		await command.handler("weekly off", ctx);

		const written = JSON.parse(readFileSync(offSettingsPath, "utf8"));
		assert.equal(written.tlh.usageLimits.showWeekly, false);
		assert.equal(shouldShowTlhUsageWeekly(written.tlh.usageLimits), false);

		const notice = notifications.at(-1);
		assert.equal(notice?.type, "info");
		assert.match(notice?.message ?? "", /hidden/);
		assert.doesNotMatch(notice?.message ?? "", /default auto mode|default when unset/);
		assert.match(notice?.message ?? "", /\/usage weekly on/);
	});

	const toggleFixture = createIsolatedProfileFixture("tlh-usage-limits-test-", { test: t });
	const toggleSettingsPath = join(toggleFixture.agent, "settings.json");

	await withEnv({ HOME: toggleFixture.home, PI_CODING_AGENT_DIR: toggleFixture.agent }, async () => {
		const command = registeredUsageCommand();
		const { ctx, notifications } = createCommandContext(toggleFixture.dir);

		await command.handler("weekly toggle", ctx);

		const written = JSON.parse(readFileSync(toggleSettingsPath, "utf8"));
		assert.equal(written.tlh.usageLimits.showWeekly, true);
		assert.equal(shouldShowTlhUsageWeekly(written.tlh.usageLimits), true);

		const notice = notifications.at(-1);
		assert.equal(notice?.type, "info");
		assert.match(notice?.message ?? "", /shown/);
		assert.match(notice?.message ?? "", /\/usage weekly off/);
	});
});

test("usage weekly writes refuse normal Pi settings", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-usage-limits-test-", { test: t });
	const normalAgent = join(fixture.home, ".pi", "agent");
	mkdirSync(normalAgent, { recursive: true });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: normalAgent }, async () => {
		const command = registeredUsageCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler("weekly on", ctx);

		assert.equal(existsSync(join(normalAgent, "settings.json")), false);
		const notice = notifications.at(-1);
		assert.equal(notice?.type, "error");
		assert.match(notice?.message ?? "", /isolated TLH profile|normal Pi config/);
	});
});
