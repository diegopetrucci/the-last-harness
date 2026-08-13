import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
	__resetModelEffortNoticeForTests,
	__setModelEffortNoticeTestHooks,
	buildModelEffortNoticeMessage,
	getChangedOverriddenRoles,
	hasAnyModelEffortOverride,
	maybeNotifyModelEffortDrift,
} = await jiti.import("../extensions/the-last-harness/model-effort-notice.ts");
const { computeModelEffortDrift, backfillMissingBaselines } = await jiti.import(
	"../extensions/the-last-harness/model-effort-reconcile.ts",
);

// ---------------------------------------------------------------------------
// Agent fixtures (mirrors reconcile-command test patterns)
// ---------------------------------------------------------------------------

/** @type {import("../extensions/the-last-harness/types.ts").AgentPrompt} */
const architectAgent = {
	name: "architect",
	description: "Primary architect agent",
	model: "anthropic/claude-opus-5",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
	tlhAnthropicModels: ["anthropic/claude-opus-5"],
	tlhAnthropicThinking: "high",
	tlhOpenaiThinking: "high",
	tools: [],
	systemPrompt: "",
	filePath: "/fake/agents/primary/architect.md",
};

/** @type {import("../extensions/the-last-harness/types.ts").SubagentMetadata} */
const developerSubagent = {
	name: "developer",
	description: "Developer subagent",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
	tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
	tlhAnthropicThinking: "medium",
	tlhOpenaiThinking: "max",
};

const primaryAgentsMap = new Map([["architect", architectAgent]]);
const subagentMetadataList = [developerSubagent];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeReconcileState(agentDir, state) {
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	writeFileSync(join(agentDir, "tlh", "reconcile-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function writeSettings(agentDir, settings) {
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

function createCtx(cwd, notifications, { hasUI = true, provider = "anthropic" } = {}) {
	return {
		cwd,
		hasUI,
		model: { provider, id: "claude-opus-5" },
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
		},
	};
}

function installNoticeHooks(t, overrides = {}) {
	__resetModelEffortNoticeForTests();
	__setModelEffortNoticeTestHooks(overrides);
	t.after(() => {
		__resetModelEffortNoticeForTests();
	});
}

/**
 * Counting loaders so agent-load assertions are real rather than incidental.
 * Returns the spy counters alongside hooks ready for installNoticeHooks.
 */
function createLoaderSpies(overrides = {}) {
	const calls = { primary: 0, subagent: 0 };
	return {
		calls,
		hooks: {
			...overrides,
			loadPrimaryAgents() {
				calls.primary += 1;
				return primaryAgentsMap;
			},
			loadSubagentMetadata() {
				calls.subagent += 1;
				return subagentMetadataList;
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Unit tests for getChangedOverriddenRoles
// ---------------------------------------------------------------------------

test("getChangedOverriddenRoles: returns empty list when no overrides exist", () => {
	const roles = getChangedOverriddenRoles(primaryAgentsMap, subagentMetadataList, {}, "anthropic", undefined);
	assert.deepEqual(roles, []);
});

test("getChangedOverriddenRoles: returns empty list when override exists but no acknowledged snapshot", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	};
	// No acknowledged snapshot — packagedDefaultsChanged is false, so no changed roles
	const roles = getChangedOverriddenRoles(primaryAgentsMap, subagentMetadataList, settings, "anthropic", undefined);
	assert.deepEqual(roles, []);
});

test("getChangedOverriddenRoles: returns empty list when acknowledged snapshot matches current packaged defaults", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	};
	// byProvider snapshot matching the current packaged defaults exactly → no change.
	const snapshot = {
		architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "high" } } },
	};
	const roles = getChangedOverriddenRoles(primaryAgentsMap, subagentMetadataList, settings, "anthropic", snapshot);
	assert.deepEqual(roles, []);
});

test("getChangedOverriddenRoles: returns role name when packaged defaults differ from acknowledged snapshot", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	};
	// byProvider snapshot reflects an older default — change should be detected.
	const snapshot = {
		architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-4-5", thinking: "high" } } },
	};
	const roles = getChangedOverriddenRoles(primaryAgentsMap, subagentMetadataList, settings, "anthropic", snapshot);
	assert.deepEqual(roles, ["architect"]);
});

test("getChangedOverriddenRoles: subagent override with changed packaged defaults returns role name", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
	};
	// byProvider snapshot reflects old packaged model — drift should be detected.
	const snapshot = {
		developer: { byProvider: { anthropic: { model: "anthropic/claude-opus-4-5" } } },
	};
	const roles = getChangedOverriddenRoles(primaryAgentsMap, subagentMetadataList, settings, "anthropic", snapshot);
	assert.deepEqual(roles, ["developer"]);
});

test("getChangedOverriddenRoles: role without override is never returned even when packaged defaults changed", () => {
	// No override for architect — no notification should fire
	const settings = {};
	const snapshot = {
		architect: { model: "anthropic/claude-opus-4-5", thinking: "high" },
	};
	const roles = getChangedOverriddenRoles(primaryAgentsMap, subagentMetadataList, settings, "anthropic", snapshot);
	assert.deepEqual(roles, []);
});

// ---------------------------------------------------------------------------
// Unit tests for buildModelEffortNoticeMessage
// ---------------------------------------------------------------------------

test("buildModelEffortNoticeMessage: single role", () => {
	const msg = buildModelEffortNoticeMessage(["architect"]);
	assert.equal(msg, "TLH default model/effort changed for architect — run /reconcile to review");
});

test("buildModelEffortNoticeMessage: multiple roles", () => {
	const msg = buildModelEffortNoticeMessage(["architect", "developer"]);
	assert.equal(msg, "TLH default model/effort changed for architect, developer — run /reconcile to review");
});

// ---------------------------------------------------------------------------
// Unit tests for hasAnyModelEffortOverride
//
// The launch-path optimization skips loading packaged agents whenever this
// returns false, so it must never report false for settings that would produce
// a drift entry. The parity test below is the real guard on that invariant.
// ---------------------------------------------------------------------------

test("hasAnyModelEffortOverride: false for empty and structurally empty settings", () => {
	for (const settings of [
		{},
		{ tlh: {} },
		{ tlh: { primaryAgent: {} } },
		{ tlh: { primaryAgent: { modelOverrides: {} } } },
		{ subagents: {} },
		{ subagents: { agentOverrides: {} } },
	]) {
		assert.equal(hasAnyModelEffortOverride(settings), false, `expected false for ${JSON.stringify(settings)}`);
	}
});

test("hasAnyModelEffortOverride: false for entries computeModelEffortDrift would skip", () => {
	for (const settings of [
		// Primary overrides must be non-empty strings.
		{ tlh: { primaryAgent: { modelOverrides: { architect: "" } } } },
		{ tlh: { primaryAgent: { modelOverrides: { architect: null } } } },
		{ tlh: { primaryAgent: { modelOverrides: { architect: 42 } } } },
		// Subagent overrides must be records carrying model or thinking.
		{ subagents: { agentOverrides: { developer: null } } },
		{ subagents: { agentOverrides: { developer: "not-a-record" } } },
		{ subagents: { agentOverrides: { developer: {} } } },
		{ subagents: { agentOverrides: { developer: { unrelated: "x" } } } },
		// model/thinking must be string | false | undefined — other types are invalid.
		{ subagents: { agentOverrides: { developer: { model: null } } } },
		{ subagents: { agentOverrides: { developer: { model: 42 } } } },
		{ subagents: { agentOverrides: { developer: { model: {} } } } },
		{ subagents: { agentOverrides: { developer: { thinking: null } } } },
		{ subagents: { agentOverrides: { developer: { thinking: 0 } } } },
	]) {
		assert.equal(hasAnyModelEffortOverride(settings), false, `expected false for ${JSON.stringify(settings)}`);
	}
});

test("hasAnyModelEffortOverride: true for entries computeModelEffortDrift would accept", () => {
	for (const settings of [
		{ tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } } },
		{ subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } } },
		// `false` is a meaningful override value (disabled), not an absent one.
		{ subagents: { agentOverrides: { developer: { model: false } } } },
		{ subagents: { agentOverrides: { developer: { thinking: "high" } } } },
		{ subagents: { agentOverrides: { developer: { thinking: false } } } },
		// Mixed: one skippable entry alongside one real entry.
		{ tlh: { primaryAgent: { modelOverrides: { architect: "", rush: "anthropic/claude-opus-5" } } } },
	]) {
		assert.equal(hasAnyModelEffortOverride(settings), true, `expected true for ${JSON.stringify(settings)}`);
	}
});

test("hasAnyModelEffortOverride agrees with computeModelEffortDrift non-emptiness", () => {
	// Guards the invariant the launch-path optimization depends on: skipping the
	// agent load is only safe while these two predicates stay in sync.
	const settingsCases = [
		{},
		{ tlh: { primaryAgent: { modelOverrides: {} } } },
		{ tlh: { primaryAgent: { modelOverrides: { architect: "" } } } },
		{ tlh: { primaryAgent: { modelOverrides: { architect: 42 } } } },
		{ tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } } },
		{ subagents: { agentOverrides: {} } },
		{ subagents: { agentOverrides: { developer: {} } } },
		{ subagents: { agentOverrides: { developer: "not-a-record" } } },
		{ subagents: { agentOverrides: { developer: { model: null } } } },
		{ subagents: { agentOverrides: { developer: { model: 42 } } } },
		{ subagents: { agentOverrides: { developer: { thinking: null } } } },
		{ subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } } },
		{ subagents: { agentOverrides: { developer: { model: false } } } },
		{ subagents: { agentOverrides: { developer: { thinking: "high" } } } },
		{
			tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
			subagents: { agentOverrides: { developer: { thinking: "medium" } } },
		},
	];

	for (const settings of settingsCases) {
		const drift = computeModelEffortDrift(primaryAgentsMap, subagentMetadataList, settings, "anthropic", undefined);
		assert.equal(
			hasAnyModelEffortOverride(settings),
			drift.length > 0,
			`predicate disagreed with computeModelEffortDrift for ${JSON.stringify(settings)}`,
		);
	}
});

// ---------------------------------------------------------------------------
// Integration tests for maybeNotifyModelEffortDrift (following update-check patterns)
// ---------------------------------------------------------------------------

test("zero-override launch path does not load packaged agents", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});

	const notifications = [];
	const { calls, hooks } = createLoaderSpies();
	installNoticeHooks(t, hooks);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		maybeNotifyModelEffortDrift(createCtx(fixture.cwd, notifications));
	});

	assert.equal(calls.primary, 0, "zero-override launch must not read packaged primary agents");
	assert.equal(calls.subagent, 0, "zero-override launch must not read packaged subagent metadata");
	assert.deepEqual(notifications, []);
});

test("launch path with an override does load packaged agents", async (t) => {
	// Positive control: proves the zero-override assertion above fails for the
	// right reason rather than because the spies are never wired up at all.
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});

	const notifications = [];
	const { calls, hooks } = createLoaderSpies();
	installNoticeHooks(t, hooks);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		maybeNotifyModelEffortDrift(createCtx(fixture.cwd, notifications));
	});

	assert.equal(calls.primary, 1, "an existing override must still load packaged primary agents");
	assert.equal(calls.subagent, 1, "an existing override must still load packaged subagent metadata");
});

test("settings with only skippable override entries do not load packaged agents", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	// Present-but-meaningless override containers must not trigger an agent load.
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "" } } },
		subagents: { agentOverrides: { developer: {} } },
	});

	const notifications = [];
	const { calls, hooks } = createLoaderSpies();
	installNoticeHooks(t, hooks);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		maybeNotifyModelEffortDrift(createCtx(fixture.cwd, notifications));
	});

	assert.equal(calls.primary, 0, "skippable override entries must not read packaged primary agents");
	assert.equal(calls.subagent, 0, "skippable override entries must not read packaged subagent metadata");
	assert.deepEqual(notifications, []);
});

test("notice not shown when there are zero overrides", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});

	const notifications = [];
	installNoticeHooks(t);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = createCtx(fixture.cwd, notifications);
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.deepEqual(notifications, []);
});

test("notice not shown when packaged defaults unchanged (snapshot matches)", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	// Architect override exists, but the byProvider snapshot matches current packaged defaults exactly.
	// Exercises the comparison path: providerEntry is present (byProvider shape), and model+thinking
	// match current packaged defaults, so packagedDefaultsChanged = false and no notice fires.
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "high" } } },
		},
	});

	const notifications = [];
	installNoticeHooks(t);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = createCtx(fixture.cwd, notifications);
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.deepEqual(notifications, []);
});

test("notice not shown in non-TUI mode (hasUI=false)", async (t) => {
	// Proves the hasUI early return in maybeNotifyModelEffortDrift suppresses an otherwise-firing
	// notice. The byProvider snapshot is stale (claude-opus-4-5 vs current claude-opus-5), so drift
	// is real — a notice would fire if hasUI=false were removed. The test must fail under mutation.
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-4-5", thinking: "high" } } },
		},
	});

	const notifications = [];
	installNoticeHooks(t);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = createCtx(fixture.cwd, notifications, { hasUI: false });
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.deepEqual(notifications, []);
});

test("notice shown when packaged defaults changed for an overridden role", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	// byProvider snapshot reflects an older packaged default — drift must be detected.
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-4-5", thinking: "high" } } },
		},
	});

	const notifications = [];
	installNoticeHooks(t);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = createCtx(fixture.cwd, notifications);
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "warning");
	assert.ok(
		notifications[0].message.includes("architect"),
		`notice message should mention the role name, got: ${notifications[0].message}`,
	);
	assert.ok(
		notifications[0].message.includes("/reconcile"),
		`notice message should mention /reconcile, got: ${notifications[0].message}`,
	);
});

test("notice shown at most once per launch (in-process dedupe)", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-4-5", thinking: "high" } } },
		},
	});

	const notifications = [];
	installNoticeHooks(t);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = createCtx(fixture.cwd, notifications);
		maybeNotifyModelEffortDrift(ctx);
		maybeNotifyModelEffortDrift(ctx);
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.equal(notifications.length, 1, "notice must appear exactly once per process");
});

test("notice display alone does not mutate reconcile state (reappears next launch)", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	const initialState = {
		acknowledgedSnapshot: {
			architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-4-5", thinking: "high" } } },
		},
	};
	writeReconcileState(fixture.agent, initialState);

	const notifications = [];
	installNoticeHooks(t);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = createCtx(fixture.cwd, notifications);
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.equal(notifications.length, 1, "notice must have been shown");

	// Now simulate a fresh launch: reset the in-process state
	__resetModelEffortNoticeForTests();

	// The reconcile state file must not have been modified
	const notificationsSecondLaunch = [];
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = createCtx(fixture.cwd, notificationsSecondLaunch);
		maybeNotifyModelEffortDrift(ctx);
	});

	// Notice should reappear since no /reconcile decision was made
	assert.equal(
		notificationsSecondLaunch.length,
		1,
		"notice must reappear on next launch because state was not modified by display",
	);
});

test("notice suppressed after /reconcile decision updates acknowledged snapshot", async (t) => {
	const { updateReconcileAcknowledgedSnapshot } = await jiti.import(
		"../extensions/the-last-harness/model-effort-reconcile.ts",
	);

	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	// byProvider stale snapshot — would normally trigger a notice.
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-4-5", thinking: "high" } } },
		},
	});

	const notifications = [];
	installNoticeHooks(t);

	// Simulate first launch — notice fires
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = createCtx(fixture.cwd, notifications);
		maybeNotifyModelEffortDrift(ctx);
	});
	assert.equal(notifications.length, 1, "notice must appear before reconcile decision");

	// Simulate user running /reconcile and choosing Keep — updates snapshot to current packaged defaults
	// (uses the byProvider shape written by the new /reconcile command).
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		updateReconcileAcknowledgedSnapshot(
			{ architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "high" } } } },
			new Date().toISOString(),
		);
	});

	// Simulate next launch — notice must not appear
	__resetModelEffortNoticeForTests();
	const notificationsAfterReconcile = [];
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = createCtx(fixture.cwd, notificationsAfterReconcile);
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.deepEqual(
		notificationsAfterReconcile,
		[],
		"notice must not appear after /reconcile decision acknowledged current defaults",
	);
});

test("no provider → notice is deferred even when override and stale snapshot exist", async (t) => {
	// Regression guard for ts-7w6o defer semantics: maybeNotifyModelEffortDrift must
	// return immediately when ctx.model?.provider is undefined, performing no comparison
	// and emitting no notification.
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	// Stale snapshot that would trigger a notice if the comparison were run.
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-4-5", thinking: "high" } } },
		},
	});

	const notifications = [];
	const spies = createLoaderSpies();
	installNoticeHooks(t, spies.hooks);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		// ctx with no provider (model is undefined)
		const ctx = {
			cwd: fixture.cwd,
			hasUI: true,
			model: undefined,
			ui: {
				notify(msg, type) {
					notifications.push({ msg, type });
				},
			},
		};
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.deepEqual(notifications, [], "no notification must fire when provider is unknown");
	// Pins the outer startup guard specifically: loader calls only happen after the
	// provider guard, so zero calls prove the guard (not a lower layer) is suppressing.
	assert.equal(
		spies.calls.primary,
		0,
		"loadPrimaryAgents must not be called when provider is unknown — the outer startup guard must block before loader calls",
	);
	assert.equal(
		spies.calls.subagent,
		0,
		"loadSubagentMetadata must not be called when provider is unknown — the outer startup guard must block before loader calls",
	);
});

test("shouldSkip hook suppresses notification completely", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-4-5", thinking: "high" } } },
		},
	});

	const notifications = [];
	installNoticeHooks(t, { shouldSkip: () => true });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = createCtx(fixture.cwd, notifications);
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.deepEqual(notifications, []);
});

// ---------------------------------------------------------------------------
// Backfill tests (ts-8kfb): pre-existing overrides with no baseline
// ---------------------------------------------------------------------------

// Re-import readReconcileState for state-verification tests.
const { readReconcileState } = await jiti.import("../extensions/the-last-harness/model-effort-reconcile.ts");

test("backfill: pre-existing primary override with no baseline is silently seeded, no notice fires (main backfill test)", async (t) => {
	// Verifies the core backfill behaviour: an override that predates baseline
	// recording (e.g. written by 0.34.0 /model) is silently seeded on first launch.
	// User-visible outcome: no notification fires in this pass.
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-backfill-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	// No reconcile-state.json at all — simulates a pre-0.34.x install where the
	// override was created before baseline recording shipped.

	const notifications = [];
	const { calls, hooks } = createLoaderSpies();
	installNoticeHooks(t, hooks);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		maybeNotifyModelEffortDrift(createCtx(fixture.cwd, notifications));
	});

	// User-visible outcome: no notice fires because the baseline was just established.
	assert.deepEqual(notifications, [], "no notice must fire when the baseline was just backfilled");

	// State-visible outcome: the backfill baseline must be persisted to disk.
	const savedState = await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () =>
		readReconcileState(),
	);
	const entry = savedState.acknowledgedSnapshot?.["architect"]?.byProvider?.["anthropic"];
	assert.ok(entry !== undefined, "backfill must have written a baseline for architect/anthropic");

	// Agents were loaded (backfill needs them for packaged-default resolution).
	assert.equal(calls.primary, 1, "agent loaders must run once");
});

test("backfill: role with stale baseline still notifies; role with no baseline is seeded silently (interaction test)", async (t) => {
	// Critical interaction test: in the same startup pass —
	//   architect: has an existing stale baseline → packagedDefaultsChanged → must notify.
	//   developer:  has no baseline → gets backfilled → must NOT notify this pass.
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-backfill-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
		subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
	});
	// Architect has a stale baseline (old model) — drift will be detected.
	// Developer has no baseline at all — will be backfilled silently.
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-4-5", thinking: "high" } } },
		},
	});

	const notifications = [];
	const { hooks } = createLoaderSpies();
	installNoticeHooks(t, hooks);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		maybeNotifyModelEffortDrift(createCtx(fixture.cwd, notifications));
	});

	// architect's stale baseline must produce exactly one notice.
	assert.equal(notifications.length, 1, "exactly one notice must fire (architect only)");
	assert.ok(
		notifications[0].message.includes("architect"),
		`notice must mention architect, got: ${notifications[0].message}`,
	);
	// developer must NOT appear in the notice — it was just backfilled.
	assert.ok(
		!notifications[0].message.includes("developer"),
		`developer must not appear in the notice (was just backfilled), got: ${notifications[0].message}`,
	);

	// developer's backfill baseline must now be persisted.
	const savedState = await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () =>
		readReconcileState(),
	);
	const devEntry = savedState.acknowledgedSnapshot?.["developer"]?.byProvider?.["anthropic"];
	assert.ok(devEntry !== undefined, "developer baseline must have been backfilled and persisted");

	// architect's existing baseline must be unchanged by the backfill write.
	const archEntry = savedState.acknowledgedSnapshot?.["architect"]?.byProvider?.["anthropic"];
	assert.ok(archEntry !== undefined, "architect baseline must still be present after backfill");
	assert.equal(
		archEntry.model,
		"anthropic/claude-opus-4-5",
		"architect baseline must not have been overwritten by backfill",
	);
});

test("backfill: subsequent packaged-default change produces notice after backfill (forward detection works)", async (t) => {
	// Verifies that once backfilled, the role can later trigger a notice when the
	// packaged default genuinely changes (the purpose of the whole baseline system).
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-backfill-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	// No reconcile-state.json — override predates baseline recording.

	const notificationsPass1 = [];
	const { hooks } = createLoaderSpies();
	installNoticeHooks(t, hooks);

	// First launch: backfill seeds the baseline to current packaged default, no notice.
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		maybeNotifyModelEffortDrift(createCtx(fixture.cwd, notificationsPass1));
	});
	assert.deepEqual(notificationsPass1, [], "no notice on backfill pass");

	// Simulate a TLH update: rewrite the reconcile state to simulate a stale baseline
	// (the packaged default changed since the backfill).
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const currentState = readReconcileState();
		const archEntry = currentState.acknowledgedSnapshot?.["architect"]?.byProvider?.["anthropic"];
		assert.ok(archEntry !== undefined, "backfill must have established a baseline");
		// Overwrite the baseline to an old model to simulate a packaged-default change.
		writeReconcileState(fixture.agent, {
			...currentState,
			acknowledgedSnapshot: {
				...currentState.acknowledgedSnapshot,
				architect: {
					byProvider: { anthropic: { model: "anthropic/claude-opus-4-5", thinking: archEntry.thinking } },
				},
			},
		});
	});

	// Second launch: packaged default is now different from the stale baseline → notice fires.
	__resetModelEffortNoticeForTests();
	const notificationsPass2 = [];
	const { hooks: hooks2 } = createLoaderSpies();
	__setModelEffortNoticeTestHooks(hooks2);
	t.after(() => {
		__resetModelEffortNoticeForTests();
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		maybeNotifyModelEffortDrift(createCtx(fixture.cwd, notificationsPass2));
	});

	assert.equal(notificationsPass2.length, 1, "notice must fire on second launch when packaged default changed");
	assert.ok(
		notificationsPass2[0].message.includes("architect"),
		`notice must mention architect, got: ${notificationsPass2[0].message}`,
	);
});

test("backfill: merges rather than replaces other roles and providers in existing state", async (t) => {
	// Verifies that backfill is additive: other roles and other providers are preserved
	// when a new baseline is written for the backfilled role.
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-backfill-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		// architect: has override, no anthropic baseline → will be backfilled.
		// developer: has override, has openai-codex baseline → must be preserved.
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
		subagents: { agentOverrides: { developer: { model: "openai-codex/gpt-5.6-luna" } } },
	});
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			// developer has a baseline for openai-codex but NOT for anthropic.
			developer: { byProvider: { "openai-codex": { model: "openai-codex/gpt-5.6-luna" } } },
		},
	});

	const notifications = [];
	const { hooks } = createLoaderSpies();
	installNoticeHooks(t, hooks);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		maybeNotifyModelEffortDrift(createCtx(fixture.cwd, notifications));
	});

	const savedState = await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () =>
		readReconcileState(),
	);

	// developer's existing openai-codex baseline must still be present (not overwritten).
	const devOpenai = savedState.acknowledgedSnapshot?.["developer"]?.byProvider?.["openai-codex"];
	assert.ok(devOpenai !== undefined, "developer openai-codex baseline must survive the backfill write");
	assert.equal(devOpenai.model, "openai-codex/gpt-5.6-luna", "developer openai-codex model must be unchanged");

	// architect must have received a new baseline (was missing before).
	const archEntry = savedState.acknowledgedSnapshot?.["architect"]?.byProvider?.["anthropic"];
	assert.ok(archEntry !== undefined, "architect anthropic baseline must have been backfilled");
});

test("backfill: unknown provider does not write state or produce notice", async (t) => {
	// Verifies the ts-7w6o defer rule: with no known provider, backfill must not
	// write anything and must not produce a notice.
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-backfill-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	// No reconcile-state.json at all.

	const notifications = [];
	const { hooks } = createLoaderSpies();
	installNoticeHooks(t, hooks);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		// Use a ctx with no provider to trigger the defer rule.
		const ctx = {
			cwd: fixture.cwd,
			hasUI: true,
			model: undefined,
			ui: {
				notify(msg, type) {
					notifications.push({ msg, type });
				},
			},
		};
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.deepEqual(notifications, [], "no notice must fire when provider is unknown");

	// No state should have been written.
	const savedState = await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () =>
		readReconcileState(),
	);
	assert.equal(savedState.acknowledgedSnapshot, undefined, "no baseline must be written when provider is unknown");
});

// ---------------------------------------------------------------------------
// Gap 1: Empty-string provider treated as unknown (ts-8k8z regression)
// ---------------------------------------------------------------------------

test("empty-string provider is treated as unknown: no notice, no loader calls, no baseline write", async (t) => {
	// Regression guard: provider="" must behave exactly like provider=undefined (ts-7w6o
	// applied consistently). Before the fix, the startup guard only deferred on === undefined,
	// so an empty-string provider would proceed, compare, and potentially fire a notice.
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	// Write a stale snapshot with an empty-key entry; sanitize must also drop it.
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: {
				byProvider: {
					"": { model: "anthropic/claude-opus-4-5", thinking: "high" },
					anthropic: { model: "anthropic/claude-opus-4-5", thinking: "high" },
				},
			},
		},
	});

	const notifications = [];
	const spies = createLoaderSpies();
	installNoticeHooks(t, spies.hooks);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		const ctx = {
			cwd: fixture.cwd,
			hasUI: true,
			model: { provider: "", id: "some-model" },
			ui: {
				notify(msg, type) {
					notifications.push({ msg, type });
				},
			},
		};
		maybeNotifyModelEffortDrift(ctx);
	});

	assert.deepEqual(notifications, [], "no notice must fire when provider is empty string");
	assert.equal(
		spies.calls.primary,
		0,
		"loadPrimaryAgents must not be called when provider is empty string — startup guard must block",
	);
	assert.equal(
		spies.calls.subagent,
		0,
		"loadSubagentMetadata must not be called when provider is empty string — startup guard must block",
	);
});

// ---------------------------------------------------------------------------
// Gap 3b: Direct backfillMissingBaselines test — in-memory merge survives failed write
// ---------------------------------------------------------------------------

test("backfill: in-memory merged snapshot is returned even when the disk write fails", async (t) => {
	// Pins the `return merged` path in backfillMissingBaselines against mutation to
	// `return snapshot`. The in-memory merge must survive a failed write so the
	// current pass cannot produce a spurious notice for a role that was just backfilled.
	//
	// Write failure is induced by making <agentDir>/tlh a file instead of a directory,
	// so writeGuardedTlhStateFile cannot create the state dir and returns false.
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-backfill-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
		// Create <agentDir>/tlh as a file to block directory creation and force write failure.
		writeFileSync(join(fixture.agent, "tlh"), "blocked");

		const existingSnapshot = {};
		const settings = {
			tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
		};

		// Must not throw even though the write fails.
		let result;
		assert.doesNotThrow(() => {
			result = backfillMissingBaselines(
				primaryAgentsMap,
				subagentMetadataList,
				settings,
				"anthropic",
				existingSnapshot,
			);
		}, "backfillMissingBaselines must not throw when the disk write fails");

		// The returned in-memory snapshot must contain the newly established baseline
		// even though nothing was persisted. This distinguishes `return merged` from
		// `return snapshot` (snapshot is {}).
		assert.ok(
			result?.architect?.byProvider?.anthropic !== undefined,
			"returned snapshot must contain the architect/anthropic baseline even when the disk write failed",
		);
	});
});
