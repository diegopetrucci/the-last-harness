import assert from "node:assert/strict";
import test from "node:test";

import {
	ALLOWED_SUBAGENTS,
	CONTRARIAN_EXPERIMENTAL_FEATURE,
	SUBAGENT_CHILD_ENV,
	allowedSubagentsForExperimentalConfig,
	registerTlhStartupMode,
	validateSubagentToolInput,
} from "../extensions/the-last-harness-subagent-safety.mjs";

function assertAllowed(input, options) {
	assert.equal(validateSubagentToolInput(input, options), undefined);
}

function createPiHarness() {
	return {
		events: [],
		commands: [],
		shortcuts: [],
		on(name, handler) {
			this.events.push({ name, handler });
		},
		registerCommand(name) {
			this.commands.push(name);
		},
		registerShortcut(name) {
			this.shortcuts.push(name);
		},
	};
}

test("ALLOWED_SUBAGENTS exposes bundled minor agents", () => {
	assert.deepEqual(ALLOWED_SUBAGENTS, [
		"developer",
		"code-reviewer",
		"repo-scout",
		"diff-summarizer",
		"librarian",
		"web-scout",
		"oracle",
		"contrarian",
	]);
});

test("validateSubagentToolInput allows bundled read-only delegation targets", () => {
	const webScout = { agent: "web-scout", prompt: "research the general web for upstream release notes" };
	assertAllowed(webScout);
	assert.equal(webScout.agentScope, "user");
	assert.equal(webScout.context, "fresh");

	const contrarian = { agent: "contrarian", prompt: "stress-test this plan by steelmanning the strongest opposing case" };
	assertAllowed(contrarian, {
		allowedSubagents: allowedSubagentsForExperimentalConfig({ enabledFeatures: [CONTRARIAN_EXPERIMENTAL_FEATURE] }),
	});
	assert.equal(contrarian.agentScope, "user");
	assert.equal(contrarian.context, "fresh");
});

test("experimental allowlist normalizes mixed-case string flags but keeps malformed mixed arrays fail-closed", () => {
	assert.deepEqual(allowedSubagentsForExperimentalConfig(undefined), ALLOWED_SUBAGENTS.filter((agent) => agent !== "contrarian"));
	assert.deepEqual(
		allowedSubagentsForExperimentalConfig({ enabledFeatures: [" Contrarian "] }),
		ALLOWED_SUBAGENTS,
	);
	assert.deepEqual(
		allowedSubagentsForExperimentalConfig({ enabledFeatures: ["Contrarian", 123] }),
		ALLOWED_SUBAGENTS.filter((agent) => agent !== "contrarian"),
	);

	const defaultBlocked = validateSubagentToolInput({ agent: "contrarian", prompt: "stress-test this plan" });
	assert.match(defaultBlocked, /experimental minor agent/i);
	assert.match(defaultBlocked, /\/experimental enable contrarian/);

	const blocked = validateSubagentToolInput(
		{ agent: "contrarian", prompt: "stress-test this plan" },
		{ allowedSubagents: allowedSubagentsForExperimentalConfig(undefined) },
	);
	assert.match(blocked, /experimental minor agent/i);
	assert.match(blocked, /\/experimental enable contrarian/);

	const malformedBlocked = validateSubagentToolInput(
		{ agent: "contrarian", prompt: "stress-test this plan" },
		{ allowedSubagents: allowedSubagentsForExperimentalConfig({ enabledFeatures: ["Contrarian", 123] }) },
	);
	assert.match(malformedBlocked, /experimental minor agent/i);
	assert.match(malformedBlocked, /\/experimental enable contrarian/);

	const enabled = { agent: "contrarian", prompt: "stress-test this plan" };
	assert.equal(
		validateSubagentToolInput(enabled, {
			allowedSubagents: allowedSubagentsForExperimentalConfig({ enabledFeatures: [CONTRARIAN_EXPERIMENTAL_FEATURE] }),
		}),
		undefined,
	);
	assert.equal(enabled.agentScope, "user");
	assert.equal(enabled.context, "fresh");
});


test("custom allowlists are bounded to canonical bundled subagents", () => {
	const customEnabled = { agent: "contrarian", prompt: "stress-test this plan" };
	assertAllowed(customEnabled, { allowedSubagents: [" Developer ", " CONTRARIAN ", "root"] });
	assert.equal(customEnabled.agentScope, "user");
	assert.equal(customEnabled.context, "fresh");

	assert.match(
		validateSubagentToolInput({ agent: "root", prompt: "do something unsafe" }, { allowedSubagents: ["developer", "root"] }),
		/Disallowed target\(s\): root/,
	);

	const emptyFallbackBlocked = validateSubagentToolInput(
		{ agent: "contrarian", prompt: "stress-test this plan" },
		{ allowedSubagents: [] },
	);
	assert.match(emptyFallbackBlocked, /experimental minor agent/i);
	assert.match(emptyFallbackBlocked, /\/experimental enable contrarian/);

	const fallbackBlocked = validateSubagentToolInput(
		{ agent: "contrarian", prompt: "stress-test this plan" },
		{ allowedSubagents: ["root", "system", ""] },
	);
	assert.match(fallbackBlocked, /experimental minor agent/i);
	assert.match(fallbackBlocked, /\/experimental enable contrarian/);
});

test("validateSubagentToolInput allows approved execution and forces fresh user context", () => {
	const single = { agent: "developer", prompt: "implement the ticket" };
	assertAllowed(single);
	assert.equal(single.agentScope, "user");
	assert.equal(single.context, "fresh");

	const batched = {
		tasks: [
			{ agent: "repo-scout", prompt: "map the repo" },
			{ agent: "librarian", prompt: "research upstream docs" },
			{ agent: "code-reviewer", prompt: "review the diff", context: "fresh" },
		],
		chain: [
			{ agent: "diff-summarizer", prompt: "summarize" },
			{ agent: "oracle", prompt: "provide a second opinion", context: "fresh" },
			{
				parallel: [
					{ agent: "developer", prompt: "fix one issue" },
					{ agent: "repo-scout", prompt: "inspect one area", context: "fresh" },
				],
			},
		],
	};
	assertAllowed(batched);
	assert.equal(batched.agentScope, "user");
	assert.equal(batched.context, "fresh");
});

test("validateSubagentToolInput allows approved management calls and normalizes safe resume controls", () => {
	const list = { action: "list" };
	assertAllowed(list);
	assert.equal(list.agentScope, "user");

	const get = { action: "get", agentScope: "" };
	assertAllowed(get);
	assert.equal(get.agentScope, "user");

	const listBoth = { action: "list", agentScope: "both" };
	assertAllowed(listBoth);
	assert.equal(listBoth.agentScope, "user");

	const getBoth = { action: "get", agentScope: "both" };
	assertAllowed(getBoth);
	assert.equal(getBoth.agentScope, "user");

	const resume = { action: "resume", id: "run-123", message: "Continue with the approved ticket.", agentScope: "", context: "" };
	assertAllowed(resume);
	assert.equal(resume.agentScope, "user");
	assert.equal(resume.context, "fresh");

	const resumeBoth = { action: "resume", id: "run-456", message: "Continue with the approved ticket.", agentScope: "both" };
	assertAllowed(resumeBoth);
	assert.equal(resumeBoth.agentScope, "user");
	assert.equal(resumeBoth.context, "fresh");

	for (const action of ["status", "interrupt", "doctor"]) {
		assertAllowed({ action });
	}
});

test("validateSubagentToolInput blocks unsafe actions, unsafe resume inputs, and non-user scopes", () => {
	assert.match(validateSubagentToolInput({ action: "delete" }), /may not use subagent management action 'delete'/);
	assert.match(validateSubagentToolInput({ agent: "developer", agentScope: "both" }), /may not use agentScope: "both"/);
	assert.match(validateSubagentToolInput({ agent: "developer", agentScope: "project" }), /may not use agentScope: "project"/);
	assert.match(validateSubagentToolInput({ agent: "librarian", agentScope: "project" }), /may not use agentScope: "project"/);
	assert.match(validateSubagentToolInput({ agent: "oracle", context: "resume" }), /may not use context: "resume"/);
	assert.match(validateSubagentToolInput({ action: "list", agentScope: "project" }), /may not use agentScope: "project"/);
	assert.match(validateSubagentToolInput({ action: "list", agentScope: "system" }), /may not use agentScope: "system"/);
	assert.match(validateSubagentToolInput({ action: "get", agentScope: "invalid" }), /may not use agentScope: "invalid"/);
	assert.match(validateSubagentToolInput({ action: "resume", agentScope: "project" }), /resume calls may not use agentScope: "project"/);
	assert.match(validateSubagentToolInput({ action: "resume", agentScope: "system" }), /resume calls may not use agentScope: "system"/);
	assert.match(validateSubagentToolInput({ action: "resume", agentScope: "invalid" }), /resume calls may not use agentScope: "invalid"/);
	assert.match(validateSubagentToolInput({ action: "resume", context: "resume" }), /subagent resume may not use context: "resume"/);
	assert.match(validateSubagentToolInput({ action: "resume", context: 1 }), /subagent resume must use context: "fresh"/);
});

test("validateSubagentToolInput uses generic primary-agent wording", () => {
	const reasons = [
		validateSubagentToolInput(null),
		validateSubagentToolInput({ action: "delete" }),
		validateSubagentToolInput({ agent: "developer", context: "resume" }),
	].filter(Boolean);

	for (const reason of reasons) {
		assert.match(reason, /TLH primary(?:-agent| agents)/);
		assert.doesNotMatch(reason, /TLH architect/);
	}
});

test("validateSubagentToolInput rejects disallowed agents", () => {
	assert.match(validateSubagentToolInput({ agent: "architect" }), /Disallowed target\(s\): architect/);
	assert.match(
		validateSubagentToolInput({ tasks: [{ agent: "developer" }, { agent: "planner" }] }),
		/Disallowed target\(s\): planner/,
	);
	assert.match(
		validateSubagentToolInput({ chain: [{ parallel: [{ agent: "repo-scout" }, { agent: "root" }] }] }),
		/Disallowed target\(s\): root/,
	);
});

test("validateSubagentToolInput rejects non-fresh top-level and nested contexts", () => {
	assert.match(validateSubagentToolInput({ agent: "developer", context: "resume" }), /may not use context: "resume"/);
	assert.match(validateSubagentToolInput({ agent: "developer", context: 1 }), /must use context: "fresh"/);
	assert.match(validateSubagentToolInput({ action: "resume", context: "resume" }), /subagent resume may not use context: "resume"/);
	assert.match(validateSubagentToolInput({ action: "resume", context: 1 }), /subagent resume must use context: "fresh"/);

	assert.match(
		validateSubagentToolInput({ tasks: [{ agent: "developer", context: "resume" }] }),
		/nested tasks\[0\]\.context may not use context: "resume"/,
	);
	assert.match(
		validateSubagentToolInput({ chain: [{ agent: "developer", context: "parent" }] }),
		/nested chain\[0\]\.context may not use context: "parent"/,
	);
	assert.match(
		validateSubagentToolInput({ chain: [{ parallel: [{ agent: "developer", context: "resume" }] }] }),
		/nested chain\[0\]\.parallel\[0\]\.context may not use context: "resume"/,
	);
	assert.match(
		validateSubagentToolInput({ tasks: [{ agent: "developer", context: "" }] }),
		/nested tasks\[0\]\.context may not use context: ""/,
	);
});

test("PI_SUBAGENT_CHILD=1 registers only child prompt behavior", async () => {
	const pi = createPiHarness();
	let parentStartupCalled = false;

	const mode = registerTlhStartupMode(pi, {
		env: { [SUBAGENT_CHILD_ENV]: "1" },
		buildChildSubagentSystemPrompt: () => "child safety prompt",
		registerParent: () => {
			parentStartupCalled = true;
			pi.on("tool_call", () => ({ block: true }));
			pi.registerCommand("dummy-parent-command");
			pi.registerShortcut("shift+tab");
		},
	});

	assert.equal(mode, "child");
	assert.equal(parentStartupCalled, false);
	assert.deepEqual(pi.events.map((event) => event.name), ["before_agent_start"]);
	assert.deepEqual(pi.commands, []);
	assert.deepEqual(pi.shortcuts, []);

	const result = await pi.events[0].handler({ systemPrompt: "base prompt" });
	assert.deepEqual(result, { systemPrompt: "base prompt\n\nchild safety prompt" });
});

test("PI_SUBAGENT_CHILD=1 prefers an explicit child registrar over the prompt-only fallback", () => {
	const pi = createPiHarness();
	let childStartupCalled = false;

	const mode = registerTlhStartupMode(pi, {
		env: { [SUBAGENT_CHILD_ENV]: "1" },
		buildChildSubagentSystemPrompt: () => {
			throw new Error("fallback child prompt registrar should not run");
		},
		registerChild: () => {
			childStartupCalled = true;
			pi.on("tool_call", () => undefined);
		},
	});

	assert.equal(mode, "child");
	assert.equal(childStartupCalled, true);
	assert.deepEqual(pi.events.map((event) => event.name), ["tool_call"]);
	assert.deepEqual(pi.commands, []);
	assert.deepEqual(pi.shortcuts, []);
});
