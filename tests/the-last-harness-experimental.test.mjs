import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const RETIRED_RUN_TESTS_LAST_FEATURE = "run-tests-last";
const LEGACY_UNKNOWN_FEATURE = "legacy-flag";
const SERIAL_TEST = { concurrency: false };
const jiti = createJiti(import.meta.url);
const {
	CI_FAILURE_INVESTIGATION_FEATURE,
	DELTA_FOLLOW_UP_REVIEWS_FEATURE,
	EMBEDDED_SUBAGENTS_FEATURE,
	TICKET_WORKFLOW_UI_FEATURE,
	buildPrimaryExperimentalPrompt,
	getTlhExperimentalConfig,
	isTlhExperimentalFeatureEnabled,
	registerExperimentalCommand,
} = await jiti.import("../extensions/the-last-harness/experimental.ts");

function createPiHarness() {
	const commands = new Map();
	const emittedEvents = [];
	return {
		commands,
		emittedEvents,
		events: {
			emit(name, payload) {
				emittedEvents.push({ name, payload });
			},
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};
}

function createCommandContext(cwd, { mode = "print", hasUI = false, selectResponses = [] } = {}) {
	const notifications = [];
	const selectCalls = [];
	const pendingSelections = [...selectResponses];
	return {
		notifications,
		selectCalls,
		ctx: {
			cwd,
			mode,
			hasUI,
			ui: {
				notify(message, type = "info") {
					notifications.push({ message, type });
				},
				async select(prompt, options) {
					selectCalls.push({ prompt, options });
					if (pendingSelections.length === 0) {
						return null;
					}
					const nextSelection = pendingSelections.shift();
					return typeof nextSelection === "function" ? nextSelection(options) : nextSelection;
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

test("experimental command registers ticket workflow, delta follow-up review, architect-only ci failure investigation, and embedded subagents flags as default-off", SERIAL_TEST, async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		assert.deepEqual(
			(await command.getArgumentCompletions("enable ")).map((completion) => completion.value),
			[
				`enable ${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`,
				`enable ${CI_FAILURE_INVESTIGATION_FEATURE}`,
				`enable ${TICKET_WORKFLOW_UI_FEATURE}`,
				`enable ${EMBEDDED_SUBAGENTS_FEATURE}`,
			],
		);
		assert.deepEqual(
			(await command.getArgumentCompletions("status ")).map((completion) => completion.value),
			[
				"status",
				`status ${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`,
				`status ${CI_FAILURE_INVESTIGATION_FEATURE}`,
				`status ${TICKET_WORKFLOW_UI_FEATURE}`,
				`status ${EMBEDDED_SUBAGENTS_FEATURE}`,
			],
		);
		assert.equal(await command.getArgumentCompletions("unknown"), null);

		const { ctx, notifications } = createCommandContext(fixture.dir);
		await command.handler("list", ctx);

		assert.equal(notifications.at(-1)?.type, "info");
		assert.match(notifications.at(-1)?.message ?? "", /TLH experimental features:/);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /contrarian/);
		assert.match(notifications.at(-1)?.message ?? "", /delta-follow-up-reviews/);
		assert.match(notifications.at(-1)?.message ?? "", /disabled \(default\)/);
		assert.match(notifications.at(-1)?.message ?? "", /\/experimental enable delta-follow-up-reviews/);
		assert.match(notifications.at(-1)?.message ?? "", /ci-failure-investigation/);
		assert.match(notifications.at(-1)?.message ?? "", /architect-only guidance/i);
		assert.match(notifications.at(-1)?.message ?? "", /\/experimental enable ci-failure-investigation/);
		assert.match(notifications.at(-1)?.message ?? "", /ticket-workflow-ui/);
		assert.match(notifications.at(-1)?.message ?? "", /experimental ticket workflow ui/i);
		assert.match(notifications.at(-1)?.message ?? "", /\/experimental enable ticket-workflow-ui/);
		assert.match(notifications.at(-1)?.message ?? "", /embedded-subagents/);
		assert.match(notifications.at(-1)?.message ?? "", /embedded\.<slug> subagents/);
		assert.match(notifications.at(-1)?.message ?? "", /\/experimental enable embedded-subagents/);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /run-tests-last/);
	});
});

test("experimental command opens a TUI picker with no args and toggles selections until cancelled", SERIAL_TEST, async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerExperimentalCommand(pi);
		const command = pi.commands.get("experimental");
		const { ctx, notifications, selectCalls } = createCommandContext(fixture.dir, {
			mode: "tui",
			hasUI: true,
			selectResponses: [(options) => options[0], null],
		});

		await command.handler("", ctx);

		assert.equal(selectCalls.length, 2);
		assert.match(selectCalls[0].prompt, /toggle tlh experimental features/i);
		assert.match(selectCalls[0].options[0], new RegExp(DELTA_FOLLOW_UP_REVIEWS_FEATURE));
		assert.match(selectCalls[0].options[0], /disabled \(default\)/i);
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).tlh.experimental.enabledFeatures[0], DELTA_FOLLOW_UP_REVIEWS_FEATURE);
		assert.match(selectCalls[1].options[0], /enabled/i);
		assert.match(notifications.at(-1)?.message ?? "", /Updated TLH experimental feature delta-follow-up-reviews/);
		assert.deepEqual(pi.emittedEvents.at(-1), {
			name: "tlh:experimental-feature-changed",
			payload: { cwd: fixture.dir, enabled: true, featureId: DELTA_FOLLOW_UP_REVIEWS_FEATURE },
		});
	});
});

test("experimental command falls back to status output with no args when UI is unavailable", SERIAL_TEST, async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		const { ctx, notifications, selectCalls } = createCommandContext(fixture.dir, { hasUI: false });

		await command.handler("", ctx);

		assert.equal(selectCalls.length, 0);
		assert.equal(notifications.at(-1)?.type, "info");
		assert.match(notifications.at(-1)?.message ?? "", /TLH experimental features:/);
		assert.match(notifications.at(-1)?.message ?? "", /delta-follow-up-reviews/);
	});
});

test("experimental command falls back to status output with no args outside TUI even when UI is available", SERIAL_TEST, async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		const { ctx, notifications, selectCalls } = createCommandContext(fixture.dir, { mode: "rpc", hasUI: true });

		await command.handler("", ctx);

		assert.equal(selectCalls.length, 0);
		assert.equal(notifications.at(-1)?.type, "info");
		assert.match(notifications.at(-1)?.message ?? "", /TLH experimental features:/);
		assert.match(notifications.at(-1)?.message ?? "", /delta-follow-up-reviews/);
	});
});

test("contrarian experimental settings stay harmless and no longer inject primary prompts", () => {
	assert.equal(buildPrimaryExperimentalPrompt({ name: "architect" }, undefined), undefined);
	assert.equal(buildPrimaryExperimentalPrompt({ name: "rush" }, undefined), undefined);

	const legacyConfig = { enabledFeatures: ["contrarian"] };
	assert.equal(buildPrimaryExperimentalPrompt({ name: "architect" }, legacyConfig), undefined);
	assert.equal(buildPrimaryExperimentalPrompt({ name: "rush" }, legacyConfig), undefined);
	assert.equal(buildPrimaryExperimentalPrompt({ name: "product" }, legacyConfig), undefined);
	assert.equal(buildPrimaryExperimentalPrompt({ name: "bug-hunter" }, legacyConfig), undefined);
	assert.equal(buildPrimaryExperimentalPrompt({ name: "developer" }, legacyConfig), undefined);
});

test("ci failure investigation prompt injection stays default-off and only enables architect read-only investigation guidance", () => {
	assert.equal(buildPrimaryExperimentalPrompt({ name: "architect" }, undefined), undefined);
	assert.equal(buildPrimaryExperimentalPrompt({ name: "rush" }, undefined), undefined);

	const enabledConfig = { enabledFeatures: [CI_FAILURE_INVESTIGATION_FEATURE] };
	assert.match(buildPrimaryExperimentalPrompt({ name: "architect" }, enabledConfig) ?? "", /## TLH Experimental Feature: ci-failure-investigation/);
	assert.match(buildPrimaryExperimentalPrompt({ name: "architect" }, enabledConfig) ?? "", /overrides the default post-PR monitor-and-ask-only step/i);
	assert.match(buildPrimaryExperimentalPrompt({ name: "architect" }, enabledConfig) ?? "", /You may do a read-only investigation before asking the user whether to proceed/i);
	assert.match(buildPrimaryExperimentalPrompt({ name: "architect" }, enabledConfig) ?? "", /Do not edit files, commit, push, rerun jobs, change the PR/i);
	assert.match(buildPrimaryExperimentalPrompt({ name: "architect" }, enabledConfig) ?? "", /edits, commits, pushes, reruns, PR changes, or other follow-up changes/i);
	assert.match(buildPrimaryExperimentalPrompt({ name: "architect" }, enabledConfig) ?? "", /ask for explicit user approval/i);
	assert.equal(buildPrimaryExperimentalPrompt({ name: "rush" }, enabledConfig), undefined);
	assert.equal(buildPrimaryExperimentalPrompt({ name: "product" }, enabledConfig), undefined);
	assert.equal(buildPrimaryExperimentalPrompt({ name: "bug-hunter" }, enabledConfig), undefined);
	assert.equal(buildPrimaryExperimentalPrompt({ name: "developer" }, enabledConfig), undefined);
});

test("experimental helpers treat stale contrarian settings as harmless while malformed arrays still fail closed", SERIAL_TEST, async (t) => {
	const enabledFixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	writeFileSync(
		join(enabledFixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [" Contrarian "] } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: enabledFixture.home, PI_CODING_AGENT_DIR: enabledFixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		const config = getTlhExperimentalConfig(enabledFixture.dir);
		assert.equal(isTlhExperimentalFeatureEnabled(config, "contrarian"), false);
		assert.equal(buildPrimaryExperimentalPrompt({ name: "architect" }, config), undefined);

		let { ctx, notifications } = createCommandContext(enabledFixture.dir);
		await command.handler("", ctx);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /contrarian/);

		({ ctx, notifications } = createCommandContext(enabledFixture.dir));
		await command.handler("status contrarian", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
	});

	const malformedFixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	writeFileSync(
		join(malformedFixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { experimental: { enabledFeatures: ["Contrarian", 123] } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: malformedFixture.home, PI_CODING_AGENT_DIR: malformedFixture.agent }, async () => {
		const command = registeredExperimentalCommand();
		const config = getTlhExperimentalConfig(malformedFixture.dir);
		assert.equal(isTlhExperimentalFeatureEnabled(config, "contrarian"), false);
		assert.equal(buildPrimaryExperimentalPrompt({ name: "architect" }, config), undefined);

		let { ctx, notifications } = createCommandContext(malformedFixture.dir);
		await command.handler("", ctx);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /contrarian/);

		({ ctx, notifications } = createCommandContext(malformedFixture.dir));
		await command.handler("status contrarian", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
	});
});

test("experimental stale settings fail closed and do not rebuild retired or promoted guidance", SERIAL_TEST, async (t) => {
	for (const enabledFeatures of [true, [123], [RETIRED_RUN_TESTS_LAST_FEATURE], ["contrarian"]]) {
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

test("ticket workflow ui flag status, enable, and disable stay default-off and preserve unrelated isolated settings", SERIAL_TEST, async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const initialSettings = `${JSON.stringify(
		{
			tlh: {
				primaryAgent: { selected: "architect" },
				experimental: { enabledFeatures: [LEGACY_UNKNOWN_FEATURE] },
			},
			theme: "dark",
		},
		null,
		2,
	)}\n`;
	writeFileSync(settingsPath, initialSettings);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredExperimentalCommand();

		let { ctx, notifications } = createCommandContext(fixture.dir);
		await command.handler(`status ${TICKET_WORKFLOW_UI_FEATURE}`, ctx);
		assert.match(notifications.at(-1)?.message ?? "", /ticket-workflow-ui: disabled \(default\)/i);
		assert.match(notifications.at(-1)?.message ?? "", /\/experimental enable ticket-workflow-ui/);

		({ ctx, notifications } = createCommandContext(fixture.dir));
		await command.handler(`enable ${TICKET_WORKFLOW_UI_FEATURE}`, ctx);

		let written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(written.theme, "dark");
		assert.deepEqual(written.tlh.primaryAgent, { selected: "architect" });
		assert.deepEqual(written.tlh.experimental.enabledFeatures, [LEGACY_UNKNOWN_FEATURE, TICKET_WORKFLOW_UI_FEATURE]);
		assert.equal(isTlhExperimentalFeatureEnabled(getTlhExperimentalConfig(fixture.dir), TICKET_WORKFLOW_UI_FEATURE), true);
		assert.match(notifications.at(-1)?.message ?? "", /Updated TLH experimental feature ticket-workflow-ui/);
		assert.match(notifications.at(-1)?.message ?? "", /Undo with \/experimental disable ticket-workflow-ui/);

		({ ctx, notifications } = createCommandContext(fixture.dir));
		await command.handler(`disable ${TICKET_WORKFLOW_UI_FEATURE}`, ctx);

		written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(written.theme, "dark");
		assert.deepEqual(written.tlh.primaryAgent, { selected: "architect" });
		assert.deepEqual(written.tlh.experimental.enabledFeatures, [LEGACY_UNKNOWN_FEATURE]);
		assert.equal(isTlhExperimentalFeatureEnabled(getTlhExperimentalConfig(fixture.dir), TICKET_WORKFLOW_UI_FEATURE), false);
		assert.match(notifications.at(-1)?.message ?? "", /It is now disabled/);
		assert.match(notifications.at(-1)?.message ?? "", /Undo with \/experimental enable ticket-workflow-ui/);
	});
});

test("experimental enable is idempotent, preserves settings, and does not clobber other enabled features", SERIAL_TEST, async (t) => {
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

test("experimental disable and normal-Pi refusal follow isolated settings rules", SERIAL_TEST, async (t) => {
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

test("experimental retired flag actions do not create settings or backups on a fresh profile", SERIAL_TEST, async (t) => {
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
