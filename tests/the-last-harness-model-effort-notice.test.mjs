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
const { computeModelEffortDrift } = await jiti.import("../extensions/the-last-harness/model-effort-reconcile.ts");

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
	// Architect override exists, but snapshot matches current packaged defaults
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: { model: "anthropic/claude-opus-5", thinking: "high" },
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
	const fixture = createIsolatedProfileFixture("tlh-model-effort-notice-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	});
	writeReconcileState(fixture.agent, {
		acknowledgedSnapshot: {
			architect: { model: "anthropic/claude-opus-4-5", thinking: "high" },
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
