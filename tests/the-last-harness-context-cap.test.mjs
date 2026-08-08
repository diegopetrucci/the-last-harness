import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerContextCap, DEFAULT_CONTEXT_CAP_TOKENS } = await jiti.import(
	"../extensions/the-last-harness/context-cap.ts",
);

const CAP = 200_000;

function createPiHarness() {
	const handlers = new Map();
	const commands = new Map();
	return {
		handlers,
		commands,
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};
}

function createModel(contextWindow = 1_000_000) {
	return { contextWindow, provider: "test-provider", id: "test-model" };
}

function createCtx(options = {}) {
	const model = options.model ?? createModel();
	const allModels = options.allModels ?? [model];
	const notifications = [];
	return {
		notifications,
		model,
		cwd: options.cwd ?? "/tmp",
		hasUI: true,
		modelRegistry: {
			getAll: () => allModels,
		},
		ui: {
			notify(message, type = "info") {
				notifications.push({ message, type });
			},
		},
	};
}

// ─── constant sanity check ────────────────────────────────────────────────────

test("DEFAULT_CONTEXT_CAP_TOKENS equals 200_000", () => {
	assert.equal(DEFAULT_CONTEXT_CAP_TOKENS, CAP);
});

// ─── command registration ─────────────────────────────────────────────────────

test("registerContextCap registers /toggle-context-cap command", () => {
	const pi = createPiHarness();
	registerContextCap(pi);
	assert.ok(pi.commands.has("toggle-context-cap"), "registers /toggle-context-cap");
	assert.ok(!pi.commands.has("context-cap"), "does not register /context-cap");
});

test("registerContextCap registers session_start, model_select, session_shutdown handlers", () => {
	const pi = createPiHarness();
	registerContextCap(pi);
	assert.ok(pi.handlers.has("session_start"), "registers session_start handler");
	assert.ok(pi.handlers.has("model_select"), "registers model_select handler");
	assert.ok(pi.handlers.has("session_shutdown"), "registers session_shutdown handler");
});

// ─── /toggle-context-cap arg rejection ───────────────────────────────────────

test("/toggle-context-cap rejects non-empty args with error notify and does not touch settings", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(
		settingsPath,
		`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerContextCap(pi);
		const command = pi.commands.get("toggle-context-cap");
		assert.ok(command, "command must be registered");

		const ctx = createCtx({ cwd: fixture.dir });
		await command.handler("something", ctx);

		assert.equal(ctx.notifications.length, 1);
		assert.equal(ctx.notifications[0].type, "error");
		assert.match(ctx.notifications[0].message, /Usage: \/toggle-context-cap/);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(written.tlh?.contextCap, undefined, "settings must remain unchanged");
	});
});

// ─── session_start caps large model ──────────────────────────────────────────

test("session_start caps a 1M-contextWindow model to 200_000 by default", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerContextCap(pi);

		const model = createModel(1_000_000);
		const ctx = createCtx({ model, cwd: fixture.dir });

		await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

		assert.equal(model.contextWindow, CAP, "contextWindow must be capped to 200_000");
	});
});

test("session_start does not cap a model whose contextWindow is already <= 200_000", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerContextCap(pi);

		const model = createModel(128_000);
		const ctx = createCtx({ model, cwd: fixture.dir });

		await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

		assert.equal(model.contextWindow, 128_000, "contextWindow must remain unchanged when already within cap");
	});
});

// ─── tlh.contextCap.disabled=true opt-out ────────────────────────────────────

test("session_start leaves contextWindow untouched when tlh.contextCap.disabled=true", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { contextCap: { disabled: true } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerContextCap(pi);

		const model = createModel(1_000_000);
		const ctx = createCtx({ model, cwd: fixture.dir });

		await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

		assert.equal(model.contextWindow, 1_000_000, "contextWindow must remain 1M when cap is disabled");
	});
});

// ─── model_select caps newly selected model ───────────────────────────────────

test("model_select caps a large model to 200_000", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerContextCap(pi);

		const newModel = createModel(900_000);
		const ctx = createCtx({ cwd: fixture.dir });

		await pi.handlers.get("model_select")?.[0]?.({ model: newModel }, ctx);

		assert.equal(newModel.contextWindow, CAP, "model_select must cap new model contextWindow");
	});
});

test("model_select leaves contextWindow untouched when tlh.contextCap.disabled=true", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { contextCap: { disabled: true } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerContextCap(pi);

		const newModel = createModel(900_000);
		const ctx = createCtx({ cwd: fixture.dir });

		await pi.handlers.get("model_select")?.[0]?.({ model: newModel }, ctx);

		assert.equal(newModel.contextWindow, 900_000, "model_select must not cap new model when disabled");
	});
});

// ─── session_shutdown restores original contextWindow ─────────────────────────

test("session_shutdown restores original contextWindow after session_start capped it", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerContextCap(pi);

		const model = createModel(1_000_000);
		const ctx = createCtx({ model, cwd: fixture.dir });

		await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		assert.equal(model.contextWindow, CAP, "contextWindow must be capped first");

		await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
		assert.equal(model.contextWindow, 1_000_000, "contextWindow must be restored after shutdown");
	});
});

// ─── /toggle-context-cap persistence + live apply/restore ────────────────────

test("/toggle-context-cap enables cap (flips disabled=true to false) and applies live", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify({ tlh: { contextCap: { disabled: true } } }, null, 2)}\n`);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerContextCap(pi);
		const command = pi.commands.get("toggle-context-cap");
		assert.ok(command, "command must be registered");

		const model = createModel(1_000_000);
		const ctx = createCtx({ model, cwd: fixture.dir });

		// Cap is currently disabled (disabled=true). Toggle should enable it.
		await command.handler("", ctx);

		// Check setting persisted
		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(written.tlh?.contextCap?.disabled, false, "disabled must be set to false after toggle");

		// Check live apply
		assert.equal(model.contextWindow, CAP, "model contextWindow must be capped immediately after toggle");

		// Check notification
		assert.equal(ctx.notifications.length, 1);
		assert.equal(ctx.notifications[0].type, "info");
		assert.match(ctx.notifications[0].message, /Context cap enabled/i);
	});
});

test("/toggle-context-cap disables cap (flips enabled to disabled=true) and restores live", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(
		settingsPath,
		`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerContextCap(pi);
		const command = pi.commands.get("toggle-context-cap");
		assert.ok(command, "command must be registered");

		// First, apply the cap so the model has been capped
		const model = createModel(1_000_000);
		const ctx = createCtx({ model, cwd: fixture.dir });
		await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		assert.equal(model.contextWindow, CAP, "contextWindow must be capped before toggle");

		// Toggle should disable the cap
		await command.handler("", ctx);

		// Check setting persisted
		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(written.tlh?.contextCap?.disabled, true, "disabled must be set to true after toggle");

		// Check live restore
		assert.equal(
			model.contextWindow,
			1_000_000,
			"model contextWindow must be restored immediately after disabling cap",
		);

		// Check notification
		assert.equal(ctx.notifications.length, 1);
		assert.equal(ctx.notifications[0].type, "info");
		assert.match(ctx.notifications[0].message, /Context cap disabled/i);
	});
});

test("/toggle-context-cap creates a backup when overwriting existing settings", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const initialSettings = `${JSON.stringify({ tlh: { contextCap: { disabled: false } } }, null, 2)}\n`;
	writeFileSync(settingsPath, initialSettings);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerContextCap(pi);
		const command = pi.commands.get("toggle-context-cap");
		assert.ok(command, "command must be registered");

		const ctx = createCtx({ cwd: fixture.dir });
		await command.handler("", ctx);

		// A backup should exist
		const backups = readdirSync(fixture.agent).filter((f) => f.startsWith("settings.json.bak-"));
		assert.equal(backups.length, 1, "exactly one backup file must exist");
		assert.equal(readFileSync(join(fixture.agent, backups[0]), "utf8"), initialSettings);

		// Notification should mention "disabled"
		assert.equal(ctx.notifications.length, 1);
		assert.equal(ctx.notifications[0].type, "info");
		assert.match(ctx.notifications[0].message, /Context cap disabled/i);
	});
});

test("/toggle-context-cap fails gracefully when outside isolated profile", async () => {
	const pi = createPiHarness();
	registerContextCap(pi);
	const command = pi.commands.get("toggle-context-cap");
	assert.ok(command, "command must be registered");

	// No PI_CODING_AGENT_DIR set → write should fail with a safe error
	const savedEnv = process.env.PI_CODING_AGENT_DIR;
	try {
		delete process.env.PI_CODING_AGENT_DIR;
		const ctx = createCtx({ cwd: "/tmp" });
		await command.handler("", ctx);
		assert.equal(ctx.notifications.length, 1);
		assert.equal(ctx.notifications[0].type, "error");
		assert.match(ctx.notifications[0].message, /Could not update context cap setting/);
	} finally {
		if (savedEnv !== undefined) {
			process.env.PI_CODING_AGENT_DIR = savedEnv;
		}
	}
});

// ─── no setStatus calls ───────────────────────────────────────────────────────

test("context-cap module source never calls ctx.ui.setStatus", async () => {
	const { readFileSync: readFs } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const src = readFs(fileURLToPath(new URL("../extensions/the-last-harness/context-cap.ts", import.meta.url)), "utf8");
	assert.doesNotMatch(src, /setStatus/, "context-cap must never call ctx.ui.setStatus");
});

// ─── structural: registerContextCap must precede the child-mode early-return gate ─

// This is a structural-not-behavioral check. It guards against reordering
// regressions where registerContextCap(pi) is moved after the early-return
// gate in theLastHarness, which would cause child subagent sessions to never
// receive the 200k context cap (regression caught in PR #103).
test("structural: registerContextCap(pi) appears before the early-return gate in theLastHarness (child-mode regression guard)", () => {
	const src = readFileSync(fileURLToPath(new URL("../extensions/the-last-harness.ts", import.meta.url)), "utf8");
	const capIndex = src.indexOf("registerContextCap(pi);");
	const gateIndex = src.indexOf("if (!primaryAgentRuntime) {");
	assert.ok(capIndex !== -1, "registerContextCap(pi) must appear in the theLastHarness extension entry point");
	assert.ok(gateIndex !== -1, "early-return gate 'if (!primaryAgentRuntime)' must appear in theLastHarness");
	assert.ok(
		capIndex < gateIndex,
		`registerContextCap(pi) must appear BEFORE the early-return gate so child subagent sessions receive the context cap. Found registerContextCap at index ${capIndex}, gate at ${gateIndex}.`,
	);
});
