import assert from "node:assert/strict";
import test from "node:test";

import {
	ALLOWED_SUBAGENTS,
	PRIMARY_SUBAGENT_ALLOWLISTS,
	SUBAGENT_CHILD_ENV,
	allowedSubagentsForPrimary,
	registerTlhStartupMode,
	validateSubagentToolInput,
} from "../extensions/the-last-harness-subagent-safety.mjs";

function assertAllowed(input, primary) {
	assert.equal(validateSubagentToolInput(input, primary), undefined);
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

test("PRIMARY_SUBAGENT_ALLOWLISTS exposes the approved per-primary delegation policy", () => {
	assert.deepEqual(PRIMARY_SUBAGENT_ALLOWLISTS, {
		architect: ["developer", "code-reviewer", "repo-scout", "diff-summarizer", "librarian", "web-scout", "oracle"],
		rush: ["web-scout"],
		product: ["repo-scout", "librarian", "oracle", "web-scout"],
		"bug-hunter": ["repo-scout", "librarian", "oracle"],
	});
	assert.deepEqual(ALLOWED_SUBAGENTS, [
		"developer",
		"code-reviewer",
		"repo-scout",
		"diff-summarizer",
		"librarian",
		"web-scout",
		"oracle",
	]);
	assert.deepEqual(allowedSubagentsForPrimary("architect"), PRIMARY_SUBAGENT_ALLOWLISTS.architect);
	assert.deepEqual(allowedSubagentsForPrimary("disabled"), ALLOWED_SUBAGENTS);
});

test("validateSubagentToolInput allows approved primary-specific targets and forces fresh user context", () => {
	const rushSingle = { agent: "web-scout", prompt: "research the general web for upstream release notes" };
	assertAllowed(rushSingle, "rush");
	assert.equal(rushSingle.agentScope, "user");
	assert.equal(rushSingle.context, "fresh");

	const architectSingle = { agent: "developer", prompt: "implement the ticket" };
	assertAllowed(architectSingle, "architect");
	assert.equal(architectSingle.agentScope, "user");
	assert.equal(architectSingle.context, "fresh");

	const architectBatched = {
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
	assertAllowed(architectBatched, "architect");
	assert.equal(architectBatched.agentScope, "user");
	assert.equal(architectBatched.context, "fresh");
});

test("validateSubagentToolInput allows approved management calls and forces user scope where needed", () => {
	const list = { action: "list" };
	assertAllowed(list);
	assert.equal(list.agentScope, "user");

	const get = { action: "get", agentScope: "" };
	assertAllowed(get);
	assert.equal(get.agentScope, "user");

	for (const action of ["status", "interrupt", "doctor"]) {
		assertAllowed({ action });
	}
});

test("validateSubagentToolInput blocks unsafe actions and non-user scopes", () => {
	assert.match(validateSubagentToolInput({ action: "resume" }), /may not use subagent management action 'resume'/);
	assert.match(validateSubagentToolInput({ action: "delete" }), /may not use subagent management action 'delete'/);
	assert.match(validateSubagentToolInput({ agent: "developer", agentScope: "project" }), /may not use agentScope: "project"/);
	assert.match(validateSubagentToolInput({ agent: "librarian", agentScope: "project" }), /may not use agentScope: "project"/);
	assert.match(validateSubagentToolInput({ agent: "oracle", context: "resume" }), /may not use context: "resume"/);
	assert.match(validateSubagentToolInput({ action: "list", agentScope: "system" }), /may not use agentScope: "system"/);
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

test("validateSubagentToolInput rejects disallowed agents with active-primary allowlists", () => {
	assert.equal(
		validateSubagentToolInput({ agent: "developer" }, "product"),
		"TLH product may delegate only to: repo-scout, librarian, oracle, web-scout. Disallowed target(s): developer.",
	);
	assert.equal(
		validateSubagentToolInput({ tasks: [{ agent: "web-scout" }, { agent: "developer" }] }, "rush"),
		"TLH rush may delegate only to: web-scout. Disallowed target(s): developer.",
	);
	assert.equal(
		validateSubagentToolInput({ chain: [{ agent: "developer" }] }, "bug-hunter"),
		"TLH bug-hunter may delegate only to: repo-scout, librarian, oracle. Disallowed target(s): developer.",
	);
	assert.equal(
		validateSubagentToolInput({ chain: [{ parallel: [{ agent: "repo-scout" }, { agent: "developer" }] }] }, "rush"),
		"TLH rush may delegate only to: web-scout. Disallowed target(s): repo-scout, developer.",
	);
	assert.match(validateSubagentToolInput({ agent: "architect" }), /Disallowed target\(s\): architect/);
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
