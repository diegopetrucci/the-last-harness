import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { cleanupTempDir, createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
	registerRuntimeHarness,
	createToolCallContext,
	writePrimaryConfig,
	selectablePrimaryAgents,
	contrarianMetadata,
	rushLikePrimary,
	lockedRushPrimary,
	createCommandContext,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

test("enabled primary mode allows approved delegation targets and forces safe top-level defaults", async () => {
	const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
	const event = {
		toolName: "subagent",
		input: {
			tasks: [
				{ agent: "repo-scout", task: "Map the repository" },
				{ agent: "web-scout", task: "Research upstream release notes" },
			],
		},
	};
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } },
	]);

	assert.equal(await toolCall(event, ctx), undefined);
	assert.equal(event.input.agentScope, "user");
	assert.equal(event.input.context, "fresh");
});

test("enabled primary mode allows contrarian by default and stale contrarian settings stay harmless", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const subagentMetadata = [contrarianMetadata()];
	const branchEntries = [{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } }];
	const blockedCtx = createToolCallContext(branchEntries, undefined, {
		cwd: fixture.cwd,
		modelRegistry: {
			getAvailable: () => [
				{ provider: "openai-codex", id: "gpt-5.4" },
				{ provider: "anthropic", id: "claude-opus-4-8" },
			],
		},
		model: { provider: "openai-codex", id: "gpt-5.4" },
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata });
		const defaultEvent = { toolName: "subagent", input: { agent: "contrarian", task: "stress-test this plan" } };
		assert.equal(await toolCall(defaultEvent, blockedCtx), undefined);
		assert.equal(defaultEvent.input.model, "anthropic/claude-opus-4-8");
		assert.equal(defaultEvent.input.agentScope, "user");
		assert.equal(defaultEvent.input.context, "fresh");

		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: ["contrarian"] } } }, null, 2)}\n`,
		);
		const legacyFlagEvent = { toolName: "subagent", input: { agent: "contrarian", task: "stress-test this plan" } };
		assert.equal(await toolCall(legacyFlagEvent, blockedCtx), undefined);
		assert.equal(legacyFlagEvent.input.model, "anthropic/claude-opus-4-8");
		assert.equal(legacyFlagEvent.input.agentScope, "user");
		assert.equal(legacyFlagEvent.input.context, "fresh");
	});
});

test("enabled primary mode blocks disallowed task delegation targets after forcing safe defaults", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const ctx = createToolCallContext(
		[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } }],
		undefined,
		{ cwd: fixture.cwd },
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
		const event = {
			toolName: "subagent",
			input: {
				tasks: [
					{ agent: "repo-scout", task: "Inspect the repo" },
					{ agent: "planner", task: "Plan the work" },
				],
			},
		};

		assert.deepEqual(await toolCall(event, ctx), {
			block: true,
			reason:
				"TLH primary agents may delegate only to: developer, code-reviewer, repo-scout, diff-summarizer, librarian, web-scout, oracle, contrarian. Disallowed target(s): planner.",
		});
		assert.equal(event.input.agentScope, "user");
		assert.equal(event.input.context, "fresh");
	});
});

test("enabled primary mode normalizes safe management list/get/resume inputs and blocks unsafe resume calls", async () => {
	const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } },
	]);
	const listEvent = { toolName: "subagent", input: { action: "list" } };
	const listBothEvent = { toolName: "subagent", input: { action: "list", agentScope: "both" } };
	const getEvent = { toolName: "subagent", input: { action: "get", agentScope: "" } };
	const getBothEvent = { toolName: "subagent", input: { action: "get", agentScope: "both" } };
	const resumeEvent = {
		toolName: "subagent",
		input: { action: "resume", id: "run-123", message: "Continue the approved ticket.", agentScope: "", context: "" },
	};
	const resumeBothEvent = {
		toolName: "subagent",
		input: { action: "resume", id: "run-456", message: "Continue the approved ticket.", agentScope: "both" },
	};
	const blockedGetEvent = { toolName: "subagent", input: { action: "get", agentScope: "project" } };
	const blockedResumeScopeEvent = { toolName: "subagent", input: { action: "resume", id: "run-123", agentScope: "system" } };
	const blockedResumeContextEvent = { toolName: "subagent", input: { action: "resume", id: "run-123", context: "resume" } };

	assert.equal(await toolCall(listEvent, ctx), undefined);
	assert.equal(listEvent.input.agentScope, "user");
	assert.equal(await toolCall(listBothEvent, ctx), undefined);
	assert.equal(listBothEvent.input.agentScope, "user");
	assert.equal(await toolCall(getEvent, ctx), undefined);
	assert.equal(getEvent.input.agentScope, "user");
	assert.equal(await toolCall(getBothEvent, ctx), undefined);
	assert.equal(getBothEvent.input.agentScope, "user");
	assert.equal(await toolCall(resumeEvent, ctx), undefined);
	assert.equal(resumeEvent.input.agentScope, "user");
	assert.equal(resumeEvent.input.context, "fresh");
	assert.equal(await toolCall(resumeBothEvent, ctx), undefined);
	assert.equal(resumeBothEvent.input.agentScope, "user");
	assert.equal(resumeBothEvent.input.context, "fresh");
	assert.deepEqual(await toolCall(blockedGetEvent, ctx), {
		block: true,
		reason: 'TLH primary-agent subagent get calls may not use agentScope: "project". TLH minor agents must run from the isolated user scope.',
	});
	assert.deepEqual(await toolCall(blockedResumeScopeEvent, ctx), {
		block: true,
		reason: 'TLH primary-agent subagent resume calls may not use agentScope: "system". TLH minor agents must run from the isolated user scope.',
	});
	assert.deepEqual(await toolCall(blockedResumeContextEvent, ctx), {
		block: true,
		reason:
			'TLH primary-agent subagent resume may not use context: "resume". TLH child sessions must start fresh so parent primary-agent/Gnosis context is not leaked.',
	});
});

test("Rush blocks subagent resume with a Rush-specific reason", async () => {
	const { toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
	const event = {
		toolName: "subagent",
		input: { action: "resume", id: "run-123", message: "Continue the approved ticket.", agentScope: "", context: "" },
	};
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
	]);

	const result = await toolCall(event, ctx);
	assert.deepEqual(result, {
		block: true,
		reason:
			"TLH Rush may not use subagent action=resume because resuming by run id or index can continue a prior developer subagent without an explicit safe target. Rush must edit directly or start a new allowed subagent with an explicit agent target.",
	});
});

test("Rush blocks developer delegation in task-based subagent plans", async () => {
	const { toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
	const event = {
		toolName: "subagent",
		input: {
			tasks: [
				{ agent: "code-reviewer", task: "Review the diff" },
				{ agent: "developer", task: "Implement the fix" },
			],
		},
	};
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
	]);

	const result = await toolCall(event, ctx);
	assert.deepEqual(result, {
		block: true,
		reason:
			"TLH Rush may not delegate implementation to developer. Rush must edit directly; use code-reviewer, repo-scout, diff-summarizer, librarian, or oracle only when Rush prompt rules allow it.",
	});
});

test("/switch-primary-agent includes Rush completions, usage, and status strings", async () => {
	const { pi } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
	const command = pi.commands.get("switch-primary-agent");
	assert.ok(command, "registers /switch-primary-agent");
	assert.equal(pi.commands.has("agent"), false);
	assert.equal(pi.commands.has("architect"), false);
	assert.equal(pi.commands.has("tlh"), false);
	assert.equal(pi.commands.has("harness"), false);

	assert.deepEqual(
		(await command.getArgumentCompletions("r")).map((completion) => completion.value),
		["rush", "reset"],
	);
	assert.deepEqual(
		(await command.getArgumentCompletions("default r")).map((completion) => completion.value),
		["default rush", "default reset"],
	);
	assert.deepEqual(
		(await command.getArgumentCompletions("model r")).map((completion) => completion.value),
		["model reset"],
	);

	const usage = createCommandContext();
	await command.handler("rush extra", usage.ctx);
	assert.deepEqual(usage.notifications.at(-1), {
		message: "Usage: /switch-primary-agent architect|rush|product|bug-hunter|disabled",
		type: "error",
	});

	const status = createCommandContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
	]);
	await command.handler("status", status.ctx);
	assert.equal(status.notifications.at(-1)?.type, "info");
	assert.match(status.notifications.at(-1)?.message ?? "", /Primary agent: rush\./);
});

test("/switch-primary-agent model reset clears the active primary model override", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);
	const initialSettings = `${JSON.stringify({
		tlh: { primaryAgent: { modelOverrides: { architect: "openai-codex/gpt-5.5" } } },
	}, null, 2)}\n`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
		const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		const command = pi.commands.get("switch-primary-agent");
		assert.ok(command, "registers /switch-primary-agent");

		const reset = createCommandContext([], {
			cwd: fixture.cwd,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai-codex", id: "gpt-5.5" },
					{ provider: "anthropic", id: "claude-opus-4-8" },
				],
			},
			model: { provider: "openai-codex", id: "gpt-5.4" },
		});
		await command.handler("model reset", reset.ctx);

		const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		assert.equal(written.tlh.primaryAgent.modelOverrides, undefined);
		assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
		assert.equal(reset.notifications.at(-1)?.type, "info");
		assert.match(reset.notifications.at(-1)?.message ?? "", /Cleared model override for architect/);
	});
});

test("/switch-primary-agent status reports model override or none", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const absentFixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writePrimaryConfig(fixture.agent, { modelOverrides: { architect: "anthropic/claude-opus-4-8" } });
		const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		const command = pi.commands.get("switch-primary-agent");
		assert.ok(command, "registers /switch-primary-agent");

		const status = createCommandContext([], { cwd: fixture.cwd });
		await command.handler("status", status.ctx);

		assert.equal(status.notifications.at(-1)?.type, "info");
		assert.match(status.notifications.at(-1)?.message ?? "", /Model override: anthropic\/claude-opus-4-8\./);
	});

	await withEnv({ HOME: absentFixture.home, PI_CODING_AGENT_DIR: absentFixture.agent }, async () => {
		const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		const command = pi.commands.get("switch-primary-agent");
		assert.ok(command, "registers /switch-primary-agent");

		const status = createCommandContext([], { cwd: absentFixture.cwd });
		await command.handler("status", status.ctx);

		assert.equal(status.notifications.at(-1)?.type, "info");
		assert.match(status.notifications.at(-1)?.message ?? "", /Model override: none\./);
	});
});

test("/switch-primary-agent status hides stale overrides for locked primaries", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const primaryAgents = new Map([["rush", lockedRushPrimary()]]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writePrimaryConfig(fixture.agent, { modelOverrides: { rush: "anthropic/claude-sonnet-4-6" } });
		const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		const command = pi.commands.get("switch-primary-agent");
		assert.ok(command, "registers /switch-primary-agent");

		const status = createCommandContext([
			{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
		], { cwd: fixture.cwd });
		await command.handler("status", status.ctx);

		assert.equal(status.notifications.at(-1)?.type, "info");
		assert.match(status.notifications.at(-1)?.message ?? "", /Primary agent: rush\./);
		assert.match(status.notifications.at(-1)?.message ?? "", /Model override: none\./);
		assert.doesNotMatch(status.notifications.at(-1)?.message ?? "", /claude-sonnet-4-6/);
	});
});

test("/switch-primary-agent model reset clears a stale locked-primary model override", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const primaryAgents = new Map([["rush", lockedRushPrimary()]]);
	const initialSettings = `${JSON.stringify({
		tlh: { primaryAgent: { modelOverrides: { rush: "anthropic/claude-sonnet-4-6" } } },
	}, null, 2)}\n`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
		const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		const command = pi.commands.get("switch-primary-agent");
		assert.ok(command, "registers /switch-primary-agent");

		const reset = createCommandContext([
			{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
		], {
			cwd: fixture.cwd,
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: { provider: "anthropic", id: "claude-sonnet-4-6" },
		});
		await command.handler("model reset", reset.ctx);

		const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
		assert.equal(written.tlh.primaryAgent.modelOverrides, undefined);
		assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
		assert.equal(reset.notifications.at(-1)?.type, "info");
		assert.match(reset.notifications.at(-1)?.message ?? "", /Cleared stale ignored model override for rush/);
	});
});

test("/switch-primary-agent default writes tlh.primaryAgent with a backup", async () => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
	const initialSettings = `${JSON.stringify({ tlh: { primaryAgent: { selected: "architect" } } }, null, 2)}\n`;

	try {
		writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			const { pi } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
			const command = pi.commands.get("switch-primary-agent");
			assert.ok(command, "registers /switch-primary-agent");

			const writeDefault = createCommandContext([], { cwd: fixture.cwd });
			await command.handler("default rush", writeDefault.ctx);

			const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
			assert.deepEqual(written.tlh.primaryAgent, { enabled: true, selected: "rush" });
			const backups = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-"));
			assert.equal(backups.length, 1);
			assert.equal(readFileSync(join(fixture.agent, backups[0]), "utf8"), initialSettings);
			assert.equal(writeDefault.notifications.at(-1)?.type, "info");
			assert.match(writeDefault.notifications.at(-1)?.message ?? "", /Updated TLH primary-agent persistent default/);
		});
	} finally {
		cleanupTempDir(fixture);
	}
});

test("/switch-primary-agent default refuses normal Pi settings", async () => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
	const normalAgent = join(fixture.home, ".pi", "agent");

	try {
		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: normalAgent }, async () => {
			const { pi } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
			const command = pi.commands.get("switch-primary-agent");
			assert.ok(command, "registers /switch-primary-agent");

			const writeDefault = createCommandContext([], { cwd: fixture.cwd });
			await command.handler("default rush", writeDefault.ctx);

			assert.equal(writeDefault.notifications.at(-1)?.type, "error");
			assert.match(writeDefault.notifications.at(-1)?.message ?? "", /isolated TLH profile|normal Pi config/);
		});
	} finally {
		cleanupTempDir(fixture);
	}
});
