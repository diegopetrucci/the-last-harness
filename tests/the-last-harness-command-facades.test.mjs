import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { registerToggleTlhGitAttributionCommand } = await jiti.import("../extensions/the-last-harness/attribution.ts");
const { registerEffortCommand } = await jiti.import("../extensions/the-last-harness/effort.ts");
const { registerExperimentalCommand, TICKET_WORKFLOW_UI_FEATURE } = await jiti.import("../extensions/the-last-harness/experimental.ts");
const { registerUsageCommand } = await jiti.import("../extensions/the-last-harness/usage-limits.ts");

function createPiHarness() {
	const commands = new Map();
	return {
		commands,
		registerCommand(name, command) {
			commands.set(name, command);
		},
		getThinkingLevel: () => "medium",
		setThinkingLevel() {},
		events: { emit() {} },
	};
}

function createCtx() {
	const notifications = [];
	return {
		notifications,
		ctx: {
			cwd: "/tmp/tlh-facade-test",
			hasUI: false,
			ui: {
				notify(message, type) {
					notifications.push({ message, type });
				},
			},
			model: { provider: "anthropic", id: "claude-sonnet-4-20250514", contextWindow: 200000 },
		},
	};
}

test("attribution facade lazy-loads on demand and retries after a failed import", async () => {
	const pi = createPiHarness();
	let attempt = 0;
	registerToggleTlhGitAttributionCommand(pi, {
		loadModule: async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new Error("boom");
			}
			return {
				handleToggleTlhGitAttributionCommand: async (_pi, _args, ctx) => {
					ctx.ui.notify("recovered", "info");
				},
			};
		},
	});
	const command = pi.commands.get("toggle-tlh-git-attribution");
	assert.equal(attempt, 0);
	await assert.rejects(() => command.handler("", createCtx().ctx), /boom/);
	const secondRun = createCtx();
	await command.handler("", secondRun.ctx);
	assert.equal(attempt, 2);
	assert.deepEqual(secondRun.notifications, [{ message: "recovered", type: "info" }]);
});

test("effort facade keeps completions eager-light and shares one lazy handler across aliases", async () => {
	const pi = createPiHarness();
	let loadCount = 0;
	const runtime = { activePrimaryAgentPrompt: () => ({ name: "architect", minThinking: "medium" }) };
	registerEffortCommand(pi, runtime, {
		loadModule: async () => {
			loadCount += 1;
			return {
				handleThinkingLevelCommand: async (_pi, _args, ctx) => {
					ctx.ui.notify("handled", "info");
				},
			};
		},
	});
	assert.deepEqual(
		pi.commands.get("effort").getArgumentCompletions("").map((item) => item.value),
		["medium", "high", "xhigh", "max"],
	);
	assert.equal(loadCount, 0);
	const effortRun = createCtx();
	await pi.commands.get("effort").handler("medium", effortRun.ctx);
	const thinkingRun = createCtx();
	await pi.commands.get("thinking").handler("high", thinkingRun.ctx);
	assert.equal(loadCount, 1);
	assert.deepEqual(effortRun.notifications, [{ message: "handled", type: "info" }]);
	assert.deepEqual(thinkingRun.notifications, [{ message: "handled", type: "info" }]);
});

test("experimental facade keeps command completions without loading the heavy command implementation", async () => {
	const pi = createPiHarness();
	let loadCount = 0;
	registerExperimentalCommand(pi, {
		loadModule: async () => {
			loadCount += 1;
			return {
				handleExperimentalCommand: async (_pi, _args, ctx) => {
					ctx.ui.notify("experimental handled", "info");
				},
			};
		},
	});
	const command = pi.commands.get("experimental");
	assert.equal(loadCount, 0);
	assert.ok(command.getArgumentCompletions(`toggle ${TICKET_WORKFLOW_UI_FEATURE}`)?.some((item) => item.value === `toggle ${TICKET_WORKFLOW_UI_FEATURE}`));
	assert.equal(loadCount, 0);
	const run = createCtx();
	await command.handler(`status ${TICKET_WORKFLOW_UI_FEATURE}`, run.ctx);
	assert.equal(loadCount, 1);
	assert.deepEqual(run.notifications, [{ message: "experimental handled", type: "info" }]);
});

test("usage facade keeps weekly completions without loading the write path until execution", async () => {
	const pi = createPiHarness();
	let loadCount = 0;
	registerUsageCommand(pi, {
		loadModule: async () => {
			loadCount += 1;
			return {
				handleUsageCommand: async (_args, ctx) => {
					ctx.ui.notify("usage handled", "info");
				},
			};
		},
	});
	const command = pi.commands.get("usage");
	assert.ok(command.getArgumentCompletions("weekly")?.some((item) => item.value === "weekly toggle"));
	assert.equal(loadCount, 0);
	const run = createCtx();
	await command.handler("status", run.ctx);
	assert.equal(loadCount, 1);
	assert.deepEqual(run.notifications, [{ message: "usage handled", type: "info" }]);
});
