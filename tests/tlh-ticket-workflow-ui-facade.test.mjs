import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
	registerLazyTlhTicketWorkflowUi,
} = await jiti.import("../extensions/the-last-harness/ticket-workflow-ui-facade.ts");
const {
	TICKET_WORKFLOW_UI_FEATURE,
	TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT,
} = await jiti.import("../extensions/the-last-harness/experimental.ts");

function createPiHarness() {
	const commands = new Map();
	const handlers = new Map();
	const eventBusHandlers = new Map();
	return {
		commands,
		handlers,
		events: {
			on(event, handler) {
				eventBusHandlers.set(event, [...(eventBusHandlers.get(event) ?? []), handler]);
			},
			emit(event, payload) {
				for (const handler of eventBusHandlers.get(event) ?? []) {
					handler(payload);
				}
			},
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
}

function createCtx(cwd) {
	return {
		hasUI: true,
		cwd,
		ui: {
			notify() {},
		},
	};
}

async function fireAll(pi, event, payload, ctx) {
	for (const handler of pi.handlers.get(event) ?? []) {
		await handler(payload, ctx);
	}
}

async function flushAsyncWork() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

test("lazy ticket workflow facade skips runtime import by default and loads it once when enabled at session start", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-facade-", { cwd: true, test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [] } } }, null, 2)}\n`);

	const loadCalls = [];
	const runtimeCalls = [];
	const runtime = {
		applyCurrentSettings(ctx) {
			runtimeCalls.push(["applyCurrentSettings", ctx.cwd]);
		},
		handleExperimentalFeatureChange(event) {
			runtimeCalls.push(["handleExperimentalFeatureChange", event.enabled]);
		},
		handleUserBash(event, ctx) {
			runtimeCalls.push(["handleUserBash", event.command, ctx.cwd]);
		},
		handleToolResult(event, ctx) {
			runtimeCalls.push(["handleToolResult", event.input.command, ctx.cwd]);
		},
	};

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerLazyTlhTicketWorkflowUi(pi, {
			loadModule: async () => {
				loadCalls.push("load");
				return {
					createTlhTicketWorkflowUiRuntime() {
						return runtime;
					},
				};
			},
		});
		const ctx = createCtx(fixture.cwd);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		await flushAsyncWork();
		assert.deepEqual(loadCalls, []);
		assert.deepEqual(runtimeCalls, []);

		writeFileSync(settingsPath, `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [TICKET_WORKFLOW_UI_FEATURE] } } }, null, 2)}\n`);
		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		await flushAsyncWork();
		assert.deepEqual(loadCalls, ["load"]);
		assert.deepEqual(runtimeCalls, [["applyCurrentSettings", fixture.cwd]]);

		await fireAll(pi, "user_bash", { command: "tk ready" }, ctx);
		await fireAll(pi, "tool_result", { toolName: "bash", input: { command: "tk ready" } }, ctx);
		assert.deepEqual(runtimeCalls.slice(1), [
			["handleUserBash", "tk ready", fixture.cwd],
			["handleToolResult", "tk ready", fixture.cwd],
		]);
	});
});

test("lazy ticket workflow facade refreshes a loaded runtime for later disabled sessions before re-enable", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-facade-", { cwd: true, test: t });
	const secondCwd = join(fixture.dir, "workspace-second");
	mkdirSync(secondCwd, { recursive: true });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [TICKET_WORKFLOW_UI_FEATURE] } } }, null, 2)}\n`);

	const loadCalls = [];
	const runtimeCalls = [];
	let activeCtx;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerLazyTlhTicketWorkflowUi(pi, {
			loadModule: async () => {
				loadCalls.push("load");
				return {
					createTlhTicketWorkflowUiRuntime() {
						return {
							applyCurrentSettings(ctx) {
								activeCtx = ctx;
								runtimeCalls.push(["applyCurrentSettings", ctx.cwd]);
							},
							handleExperimentalFeatureChange(event) {
								runtimeCalls.push(["handleExperimentalFeatureChange", event.enabled, activeCtx?.cwd]);
							},
							handleUserBash() {},
							handleToolResult() {},
						};
					},
				};
			},
		});
		const firstCtx = createCtx(fixture.cwd);
		const secondCtx = createCtx(secondCwd);

		await fireAll(pi, "session_start", { reason: "restore" }, firstCtx);
		await flushAsyncWork();
		assert.deepEqual(loadCalls, ["load"]);
		assert.deepEqual(runtimeCalls, [["applyCurrentSettings", fixture.cwd]]);

		writeFileSync(settingsPath, `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [] } } }, null, 2)}\n`);
		await fireAll(pi, "session_start", { reason: "restore" }, secondCtx);
		await flushAsyncWork();
		assert.deepEqual(loadCalls, ["load"]);
		assert.deepEqual(runtimeCalls.slice(-1), [["applyCurrentSettings", secondCwd]]);

		writeFileSync(settingsPath, `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [TICKET_WORKFLOW_UI_FEATURE] } } }, null, 2)}\n`);
		pi.events.emit(TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT, {
			cwd: secondCwd,
			enabled: true,
			featureId: TICKET_WORKFLOW_UI_FEATURE,
		});
		await flushAsyncWork();
		assert.deepEqual(runtimeCalls.slice(-1), [["handleExperimentalFeatureChange", true, secondCwd]]);
	});
});

test("lazy ticket workflow facade retries runtime import after a current-session enable failure", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-facade-", { cwd: true, test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [] } } }, null, 2)}\n`);

	let attempts = 0;
	const runtimeCalls = [];

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerLazyTlhTicketWorkflowUi(pi, {
			loadModule: async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("boom");
				}
				return {
					createTlhTicketWorkflowUiRuntime() {
						return {
							applyCurrentSettings(ctx) {
								runtimeCalls.push(["applyCurrentSettings", ctx.cwd]);
							},
							handleExperimentalFeatureChange(event) {
								runtimeCalls.push(["handleExperimentalFeatureChange", event.enabled]);
							},
							handleUserBash() {},
							handleToolResult() {},
						};
					},
				};
			},
		});
		const ctx = createCtx(fixture.cwd);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		await flushAsyncWork();

		writeFileSync(settingsPath, `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [TICKET_WORKFLOW_UI_FEATURE] } } }, null, 2)}\n`);
		pi.events.emit(TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT, {
			cwd: fixture.cwd,
			enabled: true,
			featureId: TICKET_WORKFLOW_UI_FEATURE,
		});
		await flushAsyncWork();
		assert.equal(attempts, 1);
		assert.deepEqual(runtimeCalls, []);

		pi.events.emit(TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT, {
			cwd: fixture.cwd,
			enabled: true,
			featureId: TICKET_WORKFLOW_UI_FEATURE,
		});
		await flushAsyncWork();
		assert.equal(attempts, 2);
		assert.deepEqual(runtimeCalls, [["applyCurrentSettings", fixture.cwd]]);
	});
});
