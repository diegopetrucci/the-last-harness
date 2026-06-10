import assert from "node:assert/strict";
import test from "node:test";

import {
	ALLOWED_SUBAGENTS,
	SUBAGENT_CHILD_ENV,
	registerTlhStartupMode,
	validateSubagentToolInput,
} from "../extensions/the-last-harness-subagent-safety.mjs";

function assertAllowed(input) {
	assert.equal(validateSubagentToolInput(input), undefined);
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
	]);
});

test("validateSubagentToolInput allows web-scout as a permitted delegation target", () => {
	const single = { agent: "web-scout", prompt: "research the general web for upstream release notes" };
	assertAllowed(single);
	assert.equal(single.agentScope, "user");
	assert.equal(single.context, "fresh");
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

test("validateSubagentToolInput allows approved management calls and forces user scope where needed", () => {
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

	for (const action of ["status", "interrupt", "doctor"]) {
		assertAllowed({ action });
	}
});

test("validateSubagentToolInput blocks unsafe actions and non-user scopes", () => {
	assert.match(validateSubagentToolInput({ action: "resume" }), /may not use subagent management action 'resume'/);
	assert.match(validateSubagentToolInput({ action: "delete" }), /may not use subagent management action 'delete'/);
	assert.match(validateSubagentToolInput({ agent: "developer", agentScope: "both" }), /may not use agentScope: "both"/);
	assert.match(validateSubagentToolInput({ agent: "developer", agentScope: "project" }), /may not use agentScope: "project"/);
	assert.match(validateSubagentToolInput({ agent: "librarian", agentScope: "project" }), /may not use agentScope: "project"/);
	assert.match(validateSubagentToolInput({ agent: "oracle", context: "resume" }), /may not use context: "resume"/);
	assert.match(validateSubagentToolInput({ action: "list", agentScope: "project" }), /may not use agentScope: "project"/);
	assert.match(validateSubagentToolInput({ action: "list", agentScope: "system" }), /may not use agentScope: "system"/);
	assert.match(validateSubagentToolInput({ action: "get", agentScope: "invalid" }), /may not use agentScope: "invalid"/);
});

test("validateSubagentToolInput uses generic primary-agent wording", () => {
	const reasons = [
		validateSubagentToolInput(null),
		validateSubagentToolInput({ action: "resume" }),
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
