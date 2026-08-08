import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerTlhPrimaryAgentRuntime } = await jiti.import("../extensions/the-last-harness/primary-agent-runtime.ts");
const { registerSubagentSettingsCommand, INDEPENDENCE_WARNING } = await jiti.import(
	"../extensions/the-last-harness/subagent-settings.ts",
);

function createPiHarness() {
	const commands = new Map();
	return {
		commands,
		events: [],
		activeTools: [],
		allTools: [{ name: "subagent" }],
		on(name, handler) {
			this.events.push({ name, handler });
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut() {},
		getAllTools() {
			return this.allTools;
		},
		getActiveTools() {
			return this.activeTools;
		},
		setActiveTools(tools) {
			this.activeTools = tools;
		},
		async setModel(model) {
			this.model = model;
			return true;
		},
		getThinkingLevel() {
			return "off";
		},
		setThinkingLevel() {},
		appendEntry() {},
	};
}

function createCommandContext(overrides = {}) {
	const notifications = [];
	const confirms = [];
	const selects = [];
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		mode: "tui",
		model: { provider: "openai-codex", id: "gpt-5.4" },
		modelRegistry: {
			getAvailable: () => [
				{ provider: "openai-codex", id: "gpt-5.4", reasoning: true },
				{ provider: "openai-codex", id: "gpt-5.5", reasoning: true },
				{ provider: "anthropic", id: "claude-opus-4-8", reasoning: true },
			],
		},
		ui: {
			notify(message, type = "info") {
				notifications.push({ message, type });
			},
			async confirm(title, message) {
				confirms.push({ title, message });
				return true;
			},
			async select(title, options) {
				selects.push({ title, options });
				return undefined;
			},
		},
		...overrides,
	};
	return { ctx, notifications, confirms, selects };
}

function subagentToolHandler(pi) {
	return pi.events.find((event) => event.name === "tool_call")?.handler;
}

test("subagent-settings set preserves unrelated settings and applies on the next dispatch", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	registerTlhPrimaryAgentRuntime(pi, { env: {} });
	const command = pi.commands.get("subagent-settings");
	const toolCall = subagentToolHandler(pi);
	assert.ok(command, "subagent-settings command should register");
	assert.equal(typeof toolCall, "function");

	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify(
			{
				tlh: { experimental: { enabledFeatures: ["contrarian"] } },
				subagents: {
					agentOverrides: {
						developer: { note: "keep-me" },
						external: { model: "openai-codex/gpt-5.4", thinking: "low" },
					},
				},
			},
			null,
			2,
		)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx, notifications } = createCommandContext({ cwd: fixture.cwd });
		await command.handler("set developer model openai-codex/gpt-5.4 effort high", ctx);
		assert.match(notifications[0]?.message ?? "", /Updated TLH minor-agent settings/i);

		const settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		assert.equal(settings.tlh.experimental.enabledFeatures[0], "contrarian");
		assert.deepEqual(settings.subagents.agentOverrides.developer, {
			model: "openai-codex/gpt-5.4",
			thinking: "high",
			note: "keep-me",
		});
		assert.deepEqual(settings.subagents.agentOverrides.external, { model: "openai-codex/gpt-5.4", thinking: "low" });
		assert.ok(
			readdirSync(fixture.agent).some((entry) => entry.startsWith("settings.json.bak-")),
			"settings update should create a backup",
		);

		const event = { toolName: "subagent", input: { agent: "developer", prompt: "Implement the ticket" } };
		await toolCall(event, {
			cwd: fixture.cwd,
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } },
				],
			},
			ui: { notify() {} },
			modelRegistry: ctx.modelRegistry,
			model: ctx.model,
		});
		assert.equal(event.input.model, "openai-codex/gpt-5.4:high");
	});
});

test("subagent tool-call runtime honors persisted false model and thinking sentinels", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerTlhPrimaryAgentRuntime(pi, { env: {} });
	const toolCall = subagentToolHandler(pi);
	assert.equal(typeof toolCall, "function");
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify(
			{
				subagents: {
					agentOverrides: {
						developer: { model: false },
						librarian: { thinking: false },
					},
				},
			},
			null,
			2,
		)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx, notifications } = createCommandContext({ cwd: fixture.cwd });
		const runtimeCtx = {
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => [] },
			ui: ctx.ui,
			modelRegistry: ctx.modelRegistry,
			model: ctx.model,
		};
		const inheritedEvent = { toolName: "subagent", input: { agent: "developer", prompt: "Implement" } };
		await toolCall(inheritedEvent, runtimeCtx);
		assert.equal(Object.hasOwn(inheritedEvent.input, "model"), false);
		assert.equal(Object.hasOwn(inheritedEvent.input, "fallbackModels"), false);
		assert.equal(Object.hasOwn(inheritedEvent.input, "modelFallbackNotice"), false);

		const disabledThinkingEvent = { toolName: "subagent", input: { agent: "librarian", prompt: "Research" } };
		await toolCall(disabledThinkingEvent, runtimeCtx);
		assert.equal(disabledThinkingEvent.input.model, "openai-codex/gpt-5.4:off");
		assert.deepEqual(notifications, []);
	});
});

test("subagent-settings status reports effective overrides and fixed-model independence risk", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	assert.ok(command, "subagent-settings command should register");

	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ subagents: { agentOverrides: { "code-reviewer": { model: "openai-codex/gpt-5.5", thinking: "max" } } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx, notifications } = createCommandContext({ cwd: fixture.cwd });
		await command.handler("status code-reviewer", ctx);
		const message = notifications[0]?.message ?? "";
		const messageLines = message.split("\n");
		// "max" is now a valid ThinkingLevel so it displays as a standard value, not "stored nonstandard/disabled"
		assert.match(message, /override model=openai-codex\/gpt-5\.5, effort=max/i);
		assert.match(message, /effective openai-codex\/gpt-5\.5/i);
		assert.ok(messageLines.includes(`  ${INDEPENDENCE_WARNING}`));
		// "max" is recognized but not supported by these test models (no thinkingLevelMap entry)
		assert.ok(
			messageLines.includes(
				'  TLH stored minor-agent effort "max" is not supported by openai-codex/gpt-5.5; using bundled defaults for this run.',
			),
		);
	});
});

test("subagent-settings status shows saved effort after the full exact suffix-like model identity", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	assert.ok(command, "subagent-settings command should register");

	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ subagents: { agentOverrides: { developer: { model: "openrouter/reasoner:high", thinking: "low" } } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx, notifications } = createCommandContext({
			cwd: fixture.cwd,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openrouter", id: "reasoner:high", reasoning: true },
					{ provider: "openai-codex", id: "gpt-5.4", reasoning: true },
				],
			},
		});
		await command.handler("status developer", ctx);
		assert.match(notifications[0]?.message ?? "", /override model=openrouter\/reasoner:high, effort=low/i);
		assert.match(notifications[0]?.message ?? "", /effective openrouter\/reasoner:high:low/i);
	});
});

test("subagent-settings status reports unavailable stored pins and update/reset guidance", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	assert.ok(command, "subagent-settings command should register");

	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ subagents: { agentOverrides: { "code-reviewer": { model: "openai-codex/gpt-5.999", thinking: "turbo", fallbackModels: ["saved/fallback"], note: "keep" } } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx, notifications } = createCommandContext({ cwd: fixture.cwd });
		await command.handler("status code-reviewer", ctx);
		const message = notifications[0]?.message ?? "";
		const messageLines = message.split("\n");
		assert.match(message, /override model=openai-codex\/gpt-5\.999, effort=stored nonstandard\/disabled \("turbo"\)/i);
		assert.match(message, /effective openai-codex\/gpt-5\.999/i);
		assert.ok(messageLines.includes(`  ${INDEPENDENCE_WARNING}`));
		assert.ok(
			messageLines.includes(
				'  TLH saved minor-agent model override "openai-codex/gpt-5.999" for code-reviewer is not currently available; forwarding the saved pin unchanged instead of swapping in bundled defaults. Update it with /subagent-settings set code-reviewer model <provider/id> or clear it with /subagent-settings reset code-reviewer model.',
			),
		);
		assert.ok(
			messageLines.includes(
				'  TLH ignored unsupported stored minor-agent effort "turbo" for code-reviewer; no supported model suffix could be emitted, so the subagents runtime will drop the value for a known model and fail open for an unknown model if this role is dispatched.',
			),
		);
		assert.equal(messageLines.filter((line) => line.includes("not currently available")).length, 1);
		const settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		assert.equal(settings.subagents.agentOverrides["code-reviewer"].model, "openai-codex/gpt-5.999");
		assert.equal(settings.subagents.agentOverrides["code-reviewer"].thinking, "turbo");
		assert.deepEqual(settings.subagents.agentOverrides["code-reviewer"].fallbackModels, ["saved/fallback"]);
		assert.equal(settings.subagents.agentOverrides["code-reviewer"].note, "keep");
	});
});

test("subagent-settings status shows effective off for model-only overrides on non-reasoning models", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	assert.ok(command, "subagent-settings command should register");

	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ subagents: { agentOverrides: { developer: { model: "openai-codex/plain" } } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx, notifications } = createCommandContext({
			cwd: fixture.cwd,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai-codex", id: "gpt-5.4", reasoning: true },
					{ provider: "openai-codex", id: "plain", reasoning: false },
				],
			},
		});
		await command.handler("status developer", ctx);
		assert.match(notifications[0]?.message ?? "", /override model=openai-codex\/plain, effort=default/i);
		assert.match(notifications[0]?.message ?? "", /effective openai-codex\/plain:off/i);
	});
});

test("subagent-settings reset and reset-all only clear bundled model and effort fields", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	assert.ok(command, "subagent-settings command should register");

	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify(
			{
				subagents: {
					agentOverrides: {
						developer: { model: "openai-codex/gpt-5.4", thinking: "high", note: "keep-me" },
						"code-reviewer": { model: "openai-codex/gpt-5.5" },
						external: { model: "anthropic/claude-opus-4-8", thinking: "low", keep: true },
					},
				},
			},
			null,
			2,
		)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx } = createCommandContext({ cwd: fixture.cwd });
		await command.handler("reset developer effort", ctx);
		let settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		assert.deepEqual(settings.subagents.agentOverrides.developer, { model: "openai-codex/gpt-5.4", note: "keep-me" });

		await command.handler("reset-all", ctx);
		settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		assert.deepEqual(settings.subagents.agentOverrides.developer, { note: "keep-me" });
		assert.equal(Object.hasOwn(settings.subagents.agentOverrides, "code-reviewer"), false);
		assert.deepEqual(settings.subagents.agentOverrides.external, {
			model: "anthropic/claude-opus-4-8",
			thinking: "low",
			keep: true,
		});
	});
});

test("interactive subagent-settings flow requires confirmation before setting fixed reviewer models", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	assert.ok(command, "subagent-settings command should register");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx, confirms, notifications } = createCommandContext({ cwd: fixture.cwd });
		const selections = [
			(optionSet) => optionSet.find((option) => option.includes("code-reviewer")),
			(optionSet) => optionSet.find((option) => option === "set model"),
			(optionSet) => optionSet.find((option) => option.startsWith("openai-codex/gpt-5.5")),
			() => undefined,
		];
		ctx.ui.select = async (_title, options) => selections.shift()?.(options);
		ctx.ui.confirm = async (title, message) => {
			confirms.push({ title, message });
			return false;
		};

		await command.handler("", ctx);
		assert.equal(confirms.length, 1);
		assert.match(confirms[0].message, /Provider independence is not guaranteed/i);
		assert.match(notifications.at(-1)?.message ?? "", /Model override cancelled/i);
		assert.equal(
			existsSync(join(fixture.agent, "settings.json")),
			false,
			"cancelled confirmation should not write settings",
		);
	});
});

test("subagent-settings accepts exact colon-bearing model IDs for typed and interactive model overrides", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	const colonModels = {
		getAvailable: () => [
			{ provider: "openrouter", id: "reasoner", reasoning: true },
			{ provider: "openrouter", id: "reasoner:high", reasoning: true },
			{ provider: "openai-codex", id: "gpt-5.4", reasoning: true },
		],
	};

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const typed = createCommandContext({ cwd: fixture.cwd, modelRegistry: colonModels });
		await command.handler("set developer model openrouter/reasoner:high", typed.ctx);
		assert.match(typed.notifications.at(-1)?.message ?? "", /Updated TLH minor-agent settings/i);
		let settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		assert.equal(settings.subagents.agentOverrides.developer.model, "openrouter/reasoner:high");

		const interactive = createCommandContext({ cwd: fixture.cwd, modelRegistry: colonModels });
		const selections = [
			(options) => options.find((option) => option.includes("developer")),
			(options) => options.find((option) => option === "set model"),
			(options) => options.find((option) => option.startsWith("openrouter/reasoner:high")),
			() => undefined,
		];
		interactive.ctx.ui.select = async (_title, options) => selections.shift()?.(options);
		await command.handler("", interactive.ctx);
		assert.match(
			interactive.notifications.at(-1)?.message ?? "",
			/No change to TLH minor-agent settings|Updated TLH minor-agent settings/i,
		);
		settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		assert.equal(settings.subagents.agentOverrides.developer.model, "openrouter/reasoner:high");
	});
});

test("subagent-settings keeps suffix guidance for non-exact recognized effort suffixes", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx, notifications } = createCommandContext({ cwd: fixture.cwd });
		await command.handler("set developer model openai-codex/gpt-5.4:high", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Model overrides must omit any :effort suffix/i);
		assert.equal(existsSync(join(fixture.agent, "settings.json")), false);
	});
});

test("interactive subagent-settings reports model parse failures through notifications", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	const selectedModel = { provider: "openrouter", id: "available-while-picked", reasoning: true };

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx, notifications } = createCommandContext({
			cwd: fixture.cwd,
			modelRegistry: { getAvailable: () => [selectedModel] },
		});
		const selections = [
			(options) => options.find((option) => option.includes("developer")),
			(options) => options.find((option) => option === "set model"),
			(options) => {
				const picked = options.find((option) => option.startsWith("openrouter/available-while-picked"));
				selectedModel.id = "unavailable-after-pick";
				return picked;
			},
			() => undefined,
		];
		ctx.ui.select = async (_title, options) => selections.shift()?.(options);
		await command.handler("", ctx);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/Model "openrouter\/available-while-picked" is not currently available/i,
		);
		assert.equal(existsSync(join(fixture.agent, "settings.json")), false);
	});
});

test("subagent-settings validates the final model and effort independent of set argument order", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	const limitedModels = {
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.4", reasoning: true },
			{ provider: "openai-codex", id: "limited", reasoning: true, thinkingLevelMap: { high: null } },
		],
	};

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		for (const args of [
			"set developer effort high model openai-codex/limited",
			"set developer model openai-codex/limited effort high",
		]) {
			const { ctx, notifications } = createCommandContext({ cwd: fixture.cwd, modelRegistry: limitedModels });
			await command.handler(args, ctx);
			assert.match(notifications.at(-1)?.message ?? "", /Effort "high" is not supported by openai-codex\/limited/);
			assert.equal(existsSync(join(fixture.agent, "settings.json")), false);
		}

		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ subagents: { agentOverrides: { developer: { thinking: "high" } } } }, null, 2)}\n`,
		);
		const original = readFileSync(join(fixture.agent, "settings.json"), "utf8");
		const { ctx, notifications } = createCommandContext({ cwd: fixture.cwd, modelRegistry: limitedModels });
		await command.handler("set developer model openai-codex/limited", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Effort "high" is not supported by openai-codex\/limited/);
		assert.equal(readFileSync(join(fixture.agent, "settings.json"), "utf8"), original);
	});
});

test("interactive model changes validate the persisted effort before writing", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ subagents: { agentOverrides: { developer: { thinking: "high" } } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const original = readFileSync(join(fixture.agent, "settings.json"), "utf8");
		const { ctx, notifications } = createCommandContext({
			cwd: fixture.cwd,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai-codex", id: "gpt-5.4", reasoning: true },
					{ provider: "openai-codex", id: "limited", reasoning: true, thinkingLevelMap: { high: null } },
				],
			},
		});
		const selections = [
			(options) => options.find((option) => option.includes("developer")),
			(options) => options.find((option) => option === "set model"),
			(options) => options.find((option) => option.startsWith("openai-codex/limited")),
			() => undefined,
		];
		ctx.ui.select = async (_title, options) => selections.shift()?.(options);
		await command.handler("", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Effort "high" is not supported by openai-codex\/limited/);
		assert.equal(readFileSync(join(fixture.agent, "settings.json"), "utf8"), original);
	});
});

test("subagent-settings status and picker show false sentinels with inherited model and effective off", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify(
			{
				subagents: {
					agentOverrides: {
						developer: { model: false, note: "keep" },
						librarian: { model: false, thinking: false },
					},
				},
			},
			null,
			2,
		)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const inheritedRun = createCommandContext({ cwd: fixture.cwd });
		await command.handler("status developer", inheritedRun.ctx);
		const inheritedMessage = inheritedRun.notifications.at(-1)?.message ?? "";
		assert.match(inheritedMessage, /override model=disabled \(false\), effort=default/);
		// Developer agent bundles openai thinking "max"; test model has no thinkingLevelMap for max → falls back to off.
		assert.match(inheritedMessage, /effective openai-codex\/gpt-5\.4:off/);

		const disabledRun = createCommandContext({ cwd: fixture.cwd });
		await command.handler("status librarian", disabledRun.ctx);
		const disabledMessage = disabledRun.notifications.at(-1)?.message ?? "";
		assert.match(disabledMessage, /override model=disabled \(false\), effort=disabled \(false\)/);
		assert.match(disabledMessage, /effective openai-codex\/gpt-5\.4:off/);
		assert.doesNotMatch(disabledMessage, /ignored unsupported|independence is reduced/i);

		const pickerRun = createCommandContext({ cwd: fixture.cwd });
		await command.handler("", pickerRun.ctx);
		const developerOption = pickerRun.selects[0]?.options.find((option) => option.includes("developer"));
		const librarianOption = pickerRun.selects[0]?.options.find((option) => option.includes("librarian"));
		// Developer agent bundles openai thinking "max"; test model has no thinkingLevelMap for max → falls back to off.
		assert.match(developerOption ?? "", /^● developer — openai-codex\/gpt-5\.4:off$/);
		assert.match(librarianOption ?? "", /^● librarian — openai-codex\/gpt-5\.4:off$/);
	});
});

test("subagent-settings set and field reset preserve unrelated false sentinels", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(
		settingsPath,
		`${JSON.stringify(
			{
				subagents: {
					agentOverrides: {
						developer: { model: false, note: "keep-model" },
						"code-reviewer": { thinking: false, note: "keep-thinking" },
					},
				},
			},
			null,
			2,
		)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx } = createCommandContext({ cwd: fixture.cwd });
		await command.handler("set developer effort high", ctx);
		await command.handler("set code-reviewer model anthropic/claude-opus-4-8", ctx);
		let settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(settings.subagents.agentOverrides.developer, {
			model: false,
			thinking: "high",
			note: "keep-model",
		});
		assert.deepEqual(settings.subagents.agentOverrides["code-reviewer"], {
			model: "anthropic/claude-opus-4-8",
			thinking: false,
			note: "keep-thinking",
		});

		await command.handler("reset developer effort", ctx);
		await command.handler("reset code-reviewer model", ctx);
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(settings.subagents.agentOverrides.developer, { model: false, note: "keep-model" });
		assert.deepEqual(settings.subagents.agentOverrides["code-reviewer"], { thinking: false, note: "keep-thinking" });
	});
});

test("subagent-settings status distinguishes stored nonstandard values from defaults", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ subagents: { agentOverrides: { developer: { model: false, thinking: "turbo" } } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { ctx, notifications } = createCommandContext({ cwd: fixture.cwd });
		await command.handler("status developer", ctx);
		const message = notifications.at(-1)?.message ?? "";
		assert.match(message, /override model=disabled \(false\)/);
		assert.match(message, /effort=stored nonstandard\/disabled \("turbo"\)/);
		assert.doesNotMatch(message, /override model=default, effort=default/);
		const settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		assert.equal(settings.subagents.agentOverrides.developer.model, false);
		assert.equal(settings.subagents.agentOverrides.developer.thinking, "turbo");
	});
});

test("subagent-settings headless mode refuses fixed-model pins for independence-sensitive roles", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-subagent-settings-test-", { cwd: true, test: t });
	const pi = createPiHarness();
	registerSubagentSettingsCommand(pi);
	const command = pi.commands.get("subagent-settings");
	assert.ok(command, "subagent-settings command should register");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		for (const role of ["code-reviewer", "oracle", "contrarian"]) {
			const { ctx, notifications } = createCommandContext({
				cwd: fixture.cwd,
				hasUI: false,
				mode: "headless",
			});
			await command.handler(`set ${role} model openai-codex/gpt-5.5`, ctx);
			assert.match(
				notifications.at(-1)?.message ?? "",
				/Cannot confirm the independence warning/i,
				`headless refusal expected for ${role}`,
			);
			assert.equal(existsSync(join(fixture.agent, "settings.json")), false, `no write should occur for ${role}`);
		}
	});
});
