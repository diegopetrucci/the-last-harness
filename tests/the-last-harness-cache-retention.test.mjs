import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
	ANTHROPIC_LONG_CACHE_RETENTION_TTL,
	registerAnthropicCacheRetention,
	upgradeAnthropicPrimaryRequestCacheRetention,
} = await jiti.import("../extensions/the-last-harness/cache-retention.ts");

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

function createCtx(options = {}) {
	const notifications = [];
	return {
		notifications,
		cwd: options.cwd ?? "/tmp",
		model: options.model ?? { provider: "anthropic", id: "claude-sonnet-5" },
		ui: {
			notify(message, type = "info") {
				notifications.push({ message, type });
			},
		},
	};
}

function createAnthropicPayload() {
	return {
		model: "claude-sonnet-5",
		max_tokens: 2048,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "text", text: "cache me", cache_control: { type: "ephemeral" } },
				],
			},
		],
		system: [
			{ type: "text", text: "system", cache_control: { type: "ephemeral" } },
		],
	};
}

function createPrimaryAgentRuntime(name) {
	return {
		activePrimaryAgentPrompt() {
			return name ? { name } : undefined;
		},
	};
}

test("registerAnthropicCacheRetention registers /toggle-cache-retention and before_provider_request", () => {
	const pi = createPiHarness();
	registerAnthropicCacheRetention(pi);
	assert.ok(pi.commands.has("toggle-cache-retention"));
	assert.ok(pi.handlers.has("before_provider_request"));
});

test("/toggle-cache-retention rejects arguments", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cache-retention-test-", { test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerAnthropicCacheRetention(pi);
		const command = pi.commands.get("toggle-cache-retention");
		assert.ok(command);

		const ctx = createCtx({ cwd: fixture.dir });
		await command.handler("extra", ctx);

		assert.deepEqual(ctx.notifications.at(-1), {
			message: "Usage: /toggle-cache-retention",
			type: "error",
		});
	});
});

test("/toggle-cache-retention enables default-off Anthropic retention persistently", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cache-retention-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerAnthropicCacheRetention(pi);
		const command = pi.commands.get("toggle-cache-retention");
		assert.ok(command);

		const ctx = createCtx({ cwd: fixture.dir });
		await command.handler("", ctx);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(written.tlh?.cacheRetention?.anthropic, "long");
		assert.equal(readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-")).length, 0);
		const notice = ctx.notifications.at(-1)?.message ?? "";
		assert.match(notice, /Anthropic 1-hour cache retention enabled for supported direct architect-primary requests\./);
		assert.match(notice, /Cache writes cost 2x input versus 1\.25x for 5-minute retention\./);
		assert.match(notice, /Toggle again to disable\./);
	});
});

test("/toggle-cache-retention disables persisted Anthropic retention and writes a backup", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cache-retention-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const initialSettings = `${JSON.stringify({ tlh: { cacheRetention: { anthropic: "long", futureProvider: "preserved" }, gnosis: { enabled: true } } }, null, 2)}\n`;
	writeFileSync(settingsPath, initialSettings);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerAnthropicCacheRetention(pi);
		const command = pi.commands.get("toggle-cache-retention");
		assert.ok(command);

		const ctx = createCtx({ cwd: fixture.dir });
		await command.handler("", ctx);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(written.tlh?.cacheRetention?.anthropic, undefined);
		assert.equal(written.tlh?.cacheRetention?.futureProvider, "preserved");
		assert.equal(written.tlh?.gnosis?.enabled, true);

		const backups = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-"));
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(join(fixture.agent, backups[0]), "utf8"), initialSettings);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /Anthropic long cache retention disabled; direct primary requests now use upstream cache retention behavior\./);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /Backup:/);
	});
});

test("/toggle-cache-retention rejects unsupported persisted values", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cache-retention-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const initialSettings = `${JSON.stringify({ tlh: { cacheRetention: { anthropic: "short" } } }, null, 2)}\n`;
	writeFileSync(settingsPath, initialSettings);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerAnthropicCacheRetention(pi);
		const command = pi.commands.get("toggle-cache-retention");
		assert.ok(command);

		const ctx = createCtx({ cwd: fixture.dir });
		await command.handler("", ctx);

		assert.deepEqual(ctx.notifications.at(-1), {
			message: "Could not update TLH cache retention: settings field 'tlh.cacheRetention.anthropic' must be 'long' if present",
			type: "error",
		});
		assert.equal(readFileSync(settingsPath, "utf8"), initialSettings);
	});
});

test("before_provider_request leaves payload unchanged when TLH Anthropic retention is absent or off", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cache-retention-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify({ tlh: { primaryAgent: { enabled: true, selected: "architect" } } }, null, 2)}\n`);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerAnthropicCacheRetention(pi);
		const handler = pi.handlers.get("before_provider_request")?.[0];
		assert.ok(handler);

		const payload = createAnthropicPayload();
		const ctx = createCtx({ cwd: fixture.dir });
		const result = await handler({ payload }, ctx);

		assert.equal(result, undefined);
		assert.deepEqual(payload, createAnthropicPayload());
	});
});

test("before_provider_request upgrades existing direct Anthropic cache_control blocks to ttl 1h only for architect primary", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cache-retention-test-", { test: t });
	writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { cacheRetention: { anthropic: "long" } } }, null, 2)}\n`);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const architectPi = createPiHarness();
		registerAnthropicCacheRetention(architectPi, createPrimaryAgentRuntime("architect"));
		const architectHandler = architectPi.handlers.get("before_provider_request")?.[0];
		assert.ok(architectHandler);

		const architectPayload = createAnthropicPayload();
		const ctx = createCtx({ cwd: fixture.dir, model: { provider: "anthropic", id: "claude-sonnet-5" } });
		const architectResult = await architectHandler({ payload: architectPayload }, ctx);

		assert.notEqual(architectResult, undefined);
		assert.equal(architectResult.messages[0].content[0].cache_control, undefined);
		assert.deepEqual(architectResult.messages[0].content[1].cache_control, { type: "ephemeral", ttl: ANTHROPIC_LONG_CACHE_RETENTION_TTL });
		assert.deepEqual(architectResult.system[0].cache_control, { type: "ephemeral", ttl: ANTHROPIC_LONG_CACHE_RETENTION_TTL });
		assert.equal(architectPayload.messages[0].content[1].cache_control.ttl, undefined, "returns a replaced payload without mutating the original");

		const rushPi = createPiHarness();
		registerAnthropicCacheRetention(rushPi, createPrimaryAgentRuntime("rush"));
		const rushHandler = rushPi.handlers.get("before_provider_request")?.[0];
		assert.ok(rushHandler);

		const rushPayload = createAnthropicPayload();
		const rushResult = await rushHandler({ payload: rushPayload }, ctx);
		assert.equal(rushResult, undefined);
		assert.equal(rushPayload.messages[0].content[1].cache_control.ttl, undefined);

		const disabledPi = createPiHarness();
		registerAnthropicCacheRetention(disabledPi, createPrimaryAgentRuntime());
		const disabledHandler = disabledPi.handlers.get("before_provider_request")?.[0];
		assert.ok(disabledHandler);

		const disabledPayload = createAnthropicPayload();
		const disabledResult = await disabledHandler({ payload: disabledPayload }, ctx);
		assert.equal(disabledResult, undefined);
		assert.equal(disabledPayload.messages[0].content[1].cache_control.ttl, undefined);
	});
});

test("before_provider_request leaves OpenAI and Anthropic models without long-retention compatibility unchanged when enabled", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-cache-retention-test-", { test: t });
	writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { cacheRetention: { anthropic: "long" } } }, null, 2)}\n`);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerAnthropicCacheRetention(pi, createPrimaryAgentRuntime("architect"));
		const handler = pi.handlers.get("before_provider_request")?.[0];
		assert.ok(handler);

		const openaiPayload = createAnthropicPayload();
		const openaiResult = await handler({ payload: openaiPayload }, createCtx({ cwd: fixture.dir, model: { provider: "openai-codex", id: "gpt-5.4" } }));
		assert.equal(openaiResult, undefined);
		assert.equal(openaiPayload.messages[0].content[1].cache_control.ttl, undefined);

		const compatibilityPayload = createAnthropicPayload();
		const compatibilityResult = await handler(
			{ payload: compatibilityPayload },
			createCtx({
				cwd: fixture.dir,
				model: {
					provider: "anthropic",
					id: "compat-claude",
					compat: { supportsLongCacheRetention: false },
				},
			}),
		);
		assert.equal(compatibilityResult, undefined);
		assert.equal(compatibilityPayload.messages[0].content[1].cache_control.ttl, undefined);
	});
});

test("cache retention upgrades block-level controls without recursing into tool input or schema", () => {
	const payload = {
		model: "claude-sonnet-5",
		system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
		tools: [{
			name: "example",
			description: "example tool",
			input_schema: {
				type: "object",
				properties: { cache_control: { type: "ephemeral" } },
			},
			cache_control: { type: "ephemeral" },
		}],
		messages: [{
			role: "assistant",
			content: [{
				type: "tool_use",
				id: "tool-1",
				name: "example",
				input: { cache_control: { type: "ephemeral" } },
				cache_control: { type: "ephemeral" },
			}],
		}],
	};

	const result = upgradeAnthropicPrimaryRequestCacheRetention(payload, createCtx());
	assert.equal(result.system[0].cache_control.ttl, ANTHROPIC_LONG_CACHE_RETENTION_TTL);
	assert.equal(result.tools[0].cache_control.ttl, ANTHROPIC_LONG_CACHE_RETENTION_TTL);
	assert.equal(result.messages[0].content[0].cache_control.ttl, ANTHROPIC_LONG_CACHE_RETENTION_TTL);
	assert.deepEqual(result.messages[0].content[0].input.cache_control, { type: "ephemeral" });
	assert.deepEqual(result.tools[0].input_schema.properties.cache_control, { type: "ephemeral" });
});

test("upgradeAnthropicPrimaryRequestCacheRetention only upgrades supported direct Anthropic requests", () => {
	const directPayload = createAnthropicPayload();
	const directResult = upgradeAnthropicPrimaryRequestCacheRetention(directPayload, createCtx());
	assert.deepEqual(directResult.messages[0].content[1].cache_control, { type: "ephemeral", ttl: ANTHROPIC_LONG_CACHE_RETENTION_TTL });

	const unsupportedPayload = {
		input: [{ role: "user", content: [{ type: "input_text", cache_control: { type: "ephemeral" } }] }],
	};
	assert.equal(
		upgradeAnthropicPrimaryRequestCacheRetention(unsupportedPayload, createCtx()),
		unsupportedPayload,
	);
});

test("structural: registerAnthropicCacheRetention(pi, primaryAgentRuntime) appears after the early-return gate in theLastHarness", () => {
	const src = readFileSync(fileURLToPath(new URL("../extensions/the-last-harness.ts", import.meta.url)), "utf8");
	const gateIndex = src.indexOf("if (!primaryAgentRuntime) {");
	const registerIndex = src.indexOf("registerAnthropicCacheRetention(pi, primaryAgentRuntime);");
	assert.ok(gateIndex !== -1, "early-return gate must exist");
	assert.ok(registerIndex !== -1, "registerAnthropicCacheRetention(pi, primaryAgentRuntime) must exist in the extension entry point");
	assert.ok(
		registerIndex > gateIndex,
		`registerAnthropicCacheRetention(pi, primaryAgentRuntime) must appear after the early-return gate so child sessions stay on upstream defaults. Found register at index ${registerIndex}, gate at ${gateIndex}.`,
	);
});
