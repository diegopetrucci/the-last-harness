import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { ALLOWED_SUBAGENTS } from "../extensions/the-last-harness-subagent-safety.mjs";
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
	EMBEDDED_SUBAGENTS_FEATURE,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

test("enabled primary mode allows approved delegation targets and forces safe top-level defaults", async () => {
	const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
	const event = {
		toolName: "subagent",
		input: {
			tasks: [{ agent: "repo-scout", prompt: "Map the repository" }],
			chain: [{ parallel: [{ agent: "web-scout", prompt: "Research upstream release notes" }] }],
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
		const defaultEvent = { toolName: "subagent", input: { agent: "contrarian", prompt: "stress-test this plan" } };
		assert.equal(await toolCall(defaultEvent, blockedCtx), undefined);
		assert.equal(defaultEvent.input.model, "anthropic/claude-opus-4-8");
		assert.equal(defaultEvent.input.agentScope, "user");
		assert.equal(defaultEvent.input.context, "fresh");

		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: ["contrarian"] } } }, null, 2)}\n`,
		);
		const legacyFlagEvent = { toolName: "subagent", input: { agent: "contrarian", prompt: "stress-test this plan" } };
		assert.equal(await toolCall(legacyFlagEvent, blockedCtx), undefined);
		assert.equal(legacyFlagEvent.input.model, "anthropic/claude-opus-4-8");
		assert.equal(legacyFlagEvent.input.agentScope, "user");
		assert.equal(legacyFlagEvent.input.context, "fresh");
	});
});

test("enabled primary mode blocks disallowed nested delegation targets after forcing safe defaults", async (t) => {
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
				tasks: [{ agent: "repo-scout", prompt: "Inspect the repo" }],
				chain: [{ parallel: [{ agent: "planner", prompt: "Plan the work" }] }],
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

test("Rush blocks developer delegation even inside nested subagent plans", async () => {
	const { toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
	const event = {
		toolName: "subagent",
		input: {
			chain: [
				{
					parallel: [
						{ agent: "code-reviewer", prompt: "Review the diff" },
						{ agent: "developer", prompt: "Implement the fix" },
					],
				},
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

// ─── Embedded subagents (ts-42p1) ───────────────────────────────────────────

function standardDisallowedTargetReason(target) {
	// Exact flag-off parity message from validateSubagentToolInput: no ", or embedded.<slug>" suffix.
	return `TLH primary agents may delegate only to: ${ALLOWED_SUBAGENTS.join(", ")}. Disallowed target(s): ${target}.`;
}

test("embedded subagents: flag off blocks embedded targets for architect with standard disallowed-target reason", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { applySessionStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const ctx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } }],
			undefined,
			{ cwd: fixture.cwd },
		);
		// Snapshot experimental config at session start (flag off = no settings file written)
		await applySessionStart(ctx);

		for (const input of [
			{ agent: "embedded.my-tool", prompt: "do something" },
			{ tasks: [{ agent: "embedded.my-tool", prompt: "step 1" }] },
			{ chain: [{ agent: "embedded.my-tool", prompt: "chain step" }] },
			{ chain: [{ parallel: [{ agent: "embedded.my-tool", prompt: "parallel" }] }] },
		]) {
			const result = await toolCall({ toolName: "subagent", input }, ctx);
			assert.equal(result?.block, true, `expected block for input: ${JSON.stringify(input)}`);
			// Flag-off parity: exact standard disallowed-target message, no embedded allowance suffix,
			// no selection-specific embedded wording.
			assert.equal(result?.reason, standardDisallowedTargetReason("embedded.my-tool"));
			assert.doesNotMatch(result?.reason ?? "", /, or embedded\.<slug>/);
			assert.doesNotMatch(result?.reason ?? "", /may not delegate to embedded/i);
		}
	});
});

test("embedded subagents: flag off + rush and product get the standard disallowed-target reason, never the selection-specific embedded message", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		for (const selected of ["rush", "product"]) {
			// Fresh harness per selection so each session snapshots with the flag off.
			const { applySessionStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
			const ctx = createToolCallContext(
				[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected } }],
				undefined,
				{ cwd: fixture.cwd },
			);
			// Snapshot at session start: flag off (no settings file written).
			await applySessionStart(ctx);

			const embeddedEvent = { toolName: "subagent", input: { agent: "embedded.my-tool", prompt: "do something" } };
			const result = await toolCall(embeddedEvent, ctx);
			assert.equal(result?.block, true, `expected block for ${selected}`);
			// Identical to current main: the generic disallowed-target reason, with zero embedded-specific wording.
			assert.equal(result?.reason, standardDisallowedTargetReason("embedded.my-tool"), `flag-off ${selected} must get the standard reason`);
			assert.doesNotMatch(result?.reason ?? "", /may not delegate to embedded/i);
			assert.doesNotMatch(result?.reason ?? "", /reserved for the architect/i);
			assert.doesNotMatch(result?.reason ?? "", /, or embedded\.<slug>/);
		}
	});
});

test("embedded subagents: flag on + architect allows embedded targets in single/tasks/chain/parallel shapes", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
		);
		const { applySessionStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const ctx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } }],
			undefined,
			{ cwd: fixture.cwd },
		);
		// Snapshot at session start with flag enabled
		await applySessionStart(ctx);

		// Single target
		const singleEvent = { toolName: "subagent", input: { agent: "embedded.my-tool", prompt: "do something" } };
		assert.equal(await toolCall(singleEvent, ctx), undefined, "single embedded target should be allowed for architect");
		assert.equal(singleEvent.input.agentScope, "user");
		assert.equal(singleEvent.input.context, "fresh");

		// Tasks shape
		const tasksEvent = { toolName: "subagent", input: { tasks: [{ agent: "embedded.my-tool", prompt: "step 1" }] } };
		assert.equal(await toolCall(tasksEvent, ctx), undefined, "tasks embedded target should be allowed for architect");

		// Chain shape
		const chainEvent = { toolName: "subagent", input: { chain: [{ agent: "embedded.my-tool", prompt: "chain step" }] } };
		assert.equal(await toolCall(chainEvent, ctx), undefined, "chain embedded target should be allowed for architect");

		// Parallel-in-chain shape
		const parallelEvent = {
			toolName: "subagent",
			input: { chain: [{ parallel: [{ agent: "embedded.my-tool", prompt: "parallel" }] }] },
		};
		assert.equal(await toolCall(parallelEvent, ctx), undefined, "parallel-in-chain embedded target should be allowed for architect");
	});
});

test("embedded subagents: flag on + rush blocks embedded targets with rush-specific reason; management actions exempt", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
		);
		const { applySessionStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const ctx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } }],
			undefined,
			{ cwd: fixture.cwd },
		);
		await applySessionStart(ctx);

		const embeddedEvent = { toolName: "subagent", input: { agent: "embedded.my-tool", prompt: "do something" } };
		const result = await toolCall(embeddedEvent, ctx);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /Rush may not delegate to embedded/i);

		// Management actions are exempt
		const listEvent = { toolName: "subagent", input: { action: "list" } };
		const listResult = await toolCall(listEvent, ctx);
		// Rush resume is already blocked; management actions other than resume should not be blocked by embedded check
		// (list/get/status/interrupt/doctor should pass through normally)
		assert.notEqual(listResult?.reason, result?.reason, "management action should not hit embedded block");
	});
});

test("embedded subagents: flag on + product blocks embedded targets with product-specific reason", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
		);
		const { applySessionStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const ctx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "product" } }],
			undefined,
			{ cwd: fixture.cwd },
		);
		await applySessionStart(ctx);

		const embeddedEvent = { toolName: "subagent", input: { agent: "embedded.my-tool", prompt: "do something" } };
		const result = await toolCall(embeddedEvent, ctx);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /Product may not delegate to embedded/i);
		assert.match(result?.reason ?? "", /reserved for the architect/i);
	});
});

test("embedded subagents: flag on + bug-hunter blocks embedded targets with bug-hunter-specific reason", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
		);
		const { applySessionStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const ctx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "bug-hunter" } }],
			undefined,
			{ cwd: fixture.cwd },
		);
		await applySessionStart(ctx);

		const embeddedEvent = { toolName: "subagent", input: { agent: "embedded.my-tool", prompt: "do something" } };
		const result = await toolCall(embeddedEvent, ctx);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /Bug-Hunter may not delegate to embedded/i);
		assert.match(result?.reason ?? "", /reserved for the architect/i);
	});
});

test("embedded subagents: snapshot semantics — enabling flag mid-session does NOT open the gate", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		// No settings file → flag off at session start
		const { applySessionStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const ctx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } }],
			undefined,
			{ cwd: fixture.cwd },
		);
		// Snapshot taken here: flag off
		await applySessionStart(ctx);

		// Now write settings to enable the flag mid-session
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
		);

		// Gate must still block: snapshot was taken when flag was off
		const embeddedEvent = { toolName: "subagent", input: { agent: "embedded.my-tool", prompt: "do something" } };
		const result = await toolCall(embeddedEvent, ctx);
		assert.equal(result?.block, true, "enabling flag mid-session must not open the embedded gate");
		// Still the exact flag-off standard reason: no embedded allowance suffix, no embedded-specific wording.
		assert.equal(result?.reason, standardDisallowedTargetReason("embedded.my-tool"));
		assert.doesNotMatch(result?.reason ?? "", /, or embedded\.<slug>/);
		assert.doesNotMatch(result?.reason ?? "", /may not delegate to embedded/i);
	});
});

test("embedded subagents: snapshot semantics — disabling flag mid-session does NOT close the gate", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		// Flag enabled at session start
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
		);
		const { applySessionStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const ctx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } }],
			undefined,
			{ cwd: fixture.cwd },
		);
		// Snapshot taken here: flag on
		await applySessionStart(ctx);

		// Now disable the flag mid-session
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [] } } }, null, 2)}\n`,
		);

		// Gate must still allow: snapshot was taken when flag was on
		const embeddedEvent = { toolName: "subagent", input: { agent: "embedded.my-tool", prompt: "do something" } };
		assert.equal(await toolCall(embeddedEvent, ctx), undefined, "disabling flag mid-session must not close the embedded gate");
		assert.equal(embeddedEvent.input.agentScope, "user");
		assert.equal(embeddedEvent.input.context, "fresh");
	});
});

test("embedded subagents: flag on + architect — normal (non-embedded) subagent targets still work", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
		);
		const { applySessionStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const ctx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } }],
			undefined,
			{ cwd: fixture.cwd },
		);
		await applySessionStart(ctx);

		// Normal developer target should still be blocked (wrong context, but not an embedded block)
		const normalEvent = { toolName: "subagent", input: { agent: "developer", context: "resume" } };
		const result = await toolCall(normalEvent, ctx);
		assert.equal(result?.block, true);
		// Reason should be about context, not embedded targeting
		assert.match(result?.reason ?? "", /context.*resume|resume.*context/i);
	});
});

test("embedded subagents: existing rush developer and resume blocks are preserved when flag is on", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
		);
		const { applySessionStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const rushCtx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } }],
			undefined,
			{ cwd: fixture.cwd },
		);
		await applySessionStart(rushCtx);

		// Rush resume still blocked
		const resumeEvent = { toolName: "subagent", input: { action: "resume", id: "run-123" } };
		const resumeResult = await toolCall(resumeEvent, rushCtx);
		assert.equal(resumeResult?.block, true);
		assert.match(resumeResult?.reason ?? "", /Rush may not use subagent action=resume/);

		// Rush developer still blocked
		const developerEvent = { toolName: "subagent", input: { agent: "developer", prompt: "implement this" } };
		const developerResult = await toolCall(developerEvent, rushCtx);
		assert.equal(developerResult?.block, true);
		assert.match(developerResult?.reason ?? "", /Rush may not delegate implementation to developer/);
	});
});

// ─── Multi-turn snapshot regression tests (ts-lksh) ─────────────────────────
// These tests exercise the genuine session_start → before_agent_start(xN) → tool_call
// lifecycle and must FAIL against the old per-turn-refresh code.

test("embedded subagents: multi-turn — enabling flag mid-session then re-firing before_agent_start does NOT open the gate", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		// No settings file → flag off at session start.
		const { applySessionStart, beforeAgentStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const ctx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } }],
			undefined,
			{ cwd: fixture.cwd },
		);

		// Turn 1: session start captures snapshot with flag OFF.
		await applySessionStart(ctx);
		await beforeAgentStart({ systemPrompt: "base" }, ctx);

		// Mid-session: enable the flag in settings.
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
		);

		// Turn 2: before_agent_start fires again (new turn). With the old per-turn-refresh bug,
		// this would re-read settings and open the gate. With the fix it must not.
		await beforeAgentStart({ systemPrompt: "base" }, ctx);

		const embeddedEvent = { toolName: "subagent", input: { agent: "embedded.my-tool", prompt: "do something" } };
		const result = await toolCall(embeddedEvent, ctx);
		assert.equal(result?.block, true, "enabling flag mid-session + second before_agent_start must NOT open the embedded gate");
		// Exact flag-off standard reason: no embedded suffix, no embedded-specific wording.
		assert.equal(result?.reason, standardDisallowedTargetReason("embedded.my-tool"));
		assert.doesNotMatch(result?.reason ?? "", /, or embedded\.<slug>/);
		assert.doesNotMatch(result?.reason ?? "", /may not delegate to embedded/i);
	});
});

test("embedded subagents: multi-turn — disabling flag mid-session then re-firing before_agent_start does NOT close the gate", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		// Flag ON at session start.
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
		);
		const { applySessionStart, beforeAgentStart, toolCall } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const ctx = createToolCallContext(
			[{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } }],
			undefined,
			{ cwd: fixture.cwd },
		);

		// Turn 1: session start captures snapshot with flag ON.
		await applySessionStart(ctx);
		await beforeAgentStart({ systemPrompt: "base" }, ctx);

		// Mid-session: disable the flag in settings.
		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [] } } }, null, 2)}\n`,
		);

		// Turn 2: before_agent_start fires again (new turn). With the old per-turn-refresh bug,
		// this would re-read settings and close the gate. With the fix it must not.
		await beforeAgentStart({ systemPrompt: "base" }, ctx);

		const embeddedEvent = { toolName: "subagent", input: { agent: "embedded.my-tool", prompt: "do something" } };
		assert.equal(await toolCall(embeddedEvent, ctx), undefined, "disabling flag mid-session + second before_agent_start must NOT close the embedded gate");
		assert.equal(embeddedEvent.input.agentScope, "user");
		assert.equal(embeddedEvent.input.context, "fresh");
	});
});
