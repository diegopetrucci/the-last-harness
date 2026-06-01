import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
	TLH_DEFAULT_COMMIT_ATTRIBUTION,
	buildTlhCommitAttributionPrompt,
	getTlhGitCommitAttributionBlockReason,
	registerToggleTlhGitAttributionCommand,
	resolveTlhCommitAttribution,
} = await jiti.import("../extensions/the-last-harness/attribution.ts");

function createPiHarness() {
	const commands = new Map();
	return {
		commands,
		on(_name, _handler) {
			throw new Error("unexpected runtime registration");
		},
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

function registeredToggleCommand() {
	const pi = createPiHarness();
	registerToggleTlhGitAttributionCommand(pi);
	assert.equal(pi.commands.has("attribution"), false, "does not register /attribution");
	const command = pi.commands.get("toggle-tlh-git-attribution");
	assert.ok(command, "registers /toggle-tlh-git-attribution");
	return command;
}

test("commit attribution helper resolves unset and boolean preference values", () => {
	assert.equal(
		TLH_DEFAULT_COMMIT_ATTRIBUTION,
		"🤖 Generated with [The Last Harness](https://github.com/diegopetrucci/the-last-harness)\n\nCo-authored-by: The Last Harness <hi@thelastharness.com>",
	);
	assert.deepEqual(resolveTlhCommitAttribution(undefined), {
		enabled: true,
		footer: TLH_DEFAULT_COMMIT_ATTRIBUTION,
	});
	assert.deepEqual(resolveTlhCommitAttribution({ commit: true }), {
		enabled: true,
		footer: TLH_DEFAULT_COMMIT_ATTRIBUTION,
	});
	assert.deepEqual(resolveTlhCommitAttribution({ commit: false }), {
		enabled: false,
	});
});

test("commit attribution prompt helper only renders when enabled", () => {
	assert.equal(buildTlhCommitAttributionPrompt({ enabled: false }), undefined);
	assert.match(buildTlhCommitAttributionPrompt(resolveTlhCommitAttribution(undefined)) ?? "", /## TLH Git Commit Attribution/);
	assert.match(
		buildTlhCommitAttributionPrompt(resolveTlhCommitAttribution(undefined)) ?? "",
		/Co-authored-by: The Last Harness <hi@thelastharness\.com>/,
	);
});

test("git commit attribution guard blocks only obvious unattributed inline commit commands", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const [footerHeading, footerCoAuthor] = TLH_DEFAULT_COMMIT_ATTRIBUTION.split("\n\n");
	const attributedHereDoc = `git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;

	for (const command of [
		'git commit -m "ship it"',
		'cd repo && git commit --message "ship it"',
		'git commit -am "ship it"',
		'git -C repo commit -m "ship it"',
		'git commit -F-',
		'git commit -F -',
		'git commit --file=-',
		'git commit --file -',
		`printf '${TLH_DEFAULT_COMMIT_ATTRIBUTION}' && git commit -m "ship it"`,
		`git commit -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}" && git commit -m "ship it"`,
		`git commit -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nship it"`,
		`${attributedHereDoc}\ngit commit -m "ship it"`,
	]) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
	}
	assert.equal(
		getTlhGitCommitAttributionBlockReason(
			`git commit -m "subject" -m "${footerHeading}" -m "${footerCoAuthor}"`,
			enabled,
		),
		undefined,
	);
	assert.equal(
		getTlhGitCommitAttributionBlockReason(`git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`, enabled),
		undefined,
	);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedHereDoc, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason('git commit -F .git/COMMIT_EDITMSG', enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason('git push origin HEAD', enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason('git commit -m "ship it"', disabled), undefined);
});

test("toggle attribution command accepts no arguments", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-attribution-test-", { test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredToggleCommand();
		assert.equal("getArgumentCompletions" in command, false);

		const { ctx, notifications } = createCommandContext(fixture.dir);
		await command.handler("extra", ctx);
		assert.deepEqual(notifications.at(-1), {
			message: "Usage: /toggle-tlh-git-attribution",
			type: "error",
		});
	});
});

test("toggle attribution command disables the default footer by writing false", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-attribution-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredToggleCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler("", ctx);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(written, { tlh: { attribution: { commit: false } } });
		assert.equal(readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-")).length, 0);

		const notice = notifications.at(-1);
		assert.equal(notice?.type, "info");
		assert.match(notice?.message ?? "", /Updated TLH commit attribution at /);
		assert.match(notice?.message ?? "", /TLH commit attribution is disabled\./);
		assert.doesNotMatch(notice?.message ?? "", /Backup:/);
	});
});

test("toggle attribution command re-enables by writing true and creating a backup", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-attribution-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const initialSettings = `${JSON.stringify({ tlh: { attribution: { commit: false }, gnosis: { enabled: true } } }, null, 2)}\n`;
	writeFileSync(settingsPath, initialSettings);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredToggleCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler("", ctx);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(written, { tlh: { attribution: { commit: true }, gnosis: { enabled: true } } });
		assert.equal(readFileSync(settingsPath, "utf8").includes(TLH_DEFAULT_COMMIT_ATTRIBUTION), false);

		const backups = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-"));
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(join(fixture.agent, backups[0]), "utf8"), initialSettings);

		const notice = notifications.at(-1);
		assert.equal(notice?.type, "info");
		assert.match(notice?.message ?? "", /TLH commit attribution is enabled\./);
		assert.match(notice?.message ?? "", /Backup:/);
	});
});

test("toggle attribution command rewrites attribution settings to boolean-only commit state", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-attribution-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(
		settingsPath,
		`${JSON.stringify({ tlh: { attribution: { commit: false, footer: "CUSTOM" }, gnosis: { enabled: true } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredToggleCommand();
		const { ctx } = createCommandContext(fixture.dir);

		await command.handler("", ctx);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(written, { tlh: { attribution: { commit: true }, gnosis: { enabled: true } } });
	});
});

test("toggle attribution command rejects non-boolean persisted values", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-attribution-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(
		settingsPath,
		`${JSON.stringify({ tlh: { attribution: { commit: "Signed-off-by: Custom <noreply@example.invalid>" } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredToggleCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler("", ctx);

		assert.deepEqual(notifications.at(-1), {
			message: "Could not update TLH commit attribution: settings field 'tlh.attribution.commit' must be a boolean if present",
			type: "error",
		});
	});
});
