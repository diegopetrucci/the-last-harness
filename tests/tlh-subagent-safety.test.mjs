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
		"validator",
		"code-reviewer",
		"repo-scout",
		"diff-summarizer",
		"librarian",
		"web-scout",
		"oracle",
	]);
});

test("PRIMARY_SUBAGENT_ALLOWLISTS keeps documented primary delegation boundaries", () => {
	assert.deepEqual(PRIMARY_SUBAGENT_ALLOWLISTS.architect, ALLOWED_SUBAGENTS);
	assert.deepEqual(PRIMARY_SUBAGENT_ALLOWLISTS.product, ["repo-scout", "librarian"]);
	assert.deepEqual(PRIMARY_SUBAGENT_ALLOWLISTS["bug-hunter"], ["repo-scout", "librarian", "oracle"]);
	assert.deepEqual(PRIMARY_SUBAGENT_ALLOWLISTS.rush, ["repo-scout", "diff-summarizer", "librarian", "code-reviewer", "oracle"]);
	assert.deepEqual(allowedSubagentsForPrimary("architect"), ALLOWED_SUBAGENTS);
	assert.deepEqual(allowedSubagentsForPrimary("unknown"), ALLOWED_SUBAGENTS);
});

test("validateSubagentToolInput allows validator for architect while forcing safe defaults", () => {
	const single = { agent: "validator", prompt: "run source-read-only validation for the completed ticket" };
	assertAllowed(single, { primaryAgent: "architect" });
	assert.equal(single.agentScope, "user");
	assert.equal(single.context, "fresh");
});

test("validateSubagentToolInput allows web-scout as a permitted delegation target", () => {
	const single = { agent: "web-scout", prompt: "research the general web for upstream release notes" };
	assertAllowed(single);
	assert.equal(single.agentScope, "user");
	assert.equal(single.context, "fresh");
});

test("validateSubagentToolInput enforces per-primary delegation allowlists", () => {
	const productAllowed = { tasks: [{ agent: "repo-scout", prompt: "map the repo" }, { agent: "librarian", prompt: "research upstream docs" }] };
	assertAllowed(productAllowed, { primaryAgent: "product" });
	assert.equal(productAllowed.agentScope, "user");
	assert.equal(productAllowed.context, "fresh");
	assert.match(
		validateSubagentToolInput({ agent: "validator", prompt: "validate it" }, { primaryAgent: "product" }),
		/TLH product may delegate only to: repo-scout, librarian\. Disallowed target\(s\): validator\./,
	);
	assert.match(
		validateSubagentToolInput({ agent: "developer", prompt: "implement it" }, { primaryAgent: "product" }),
		/TLH product may delegate only to: repo-scout, librarian\. Disallowed target\(s\): developer\./,
	);
	assert.match(
		validateSubagentToolInput({ agent: "code-reviewer", prompt: "review it" }, { primaryAgent: "product" }),
		/TLH product may delegate only to: repo-scout, librarian\. Disallowed target\(s\): code-reviewer\./,
	);

	const bugHunterAllowed = { tasks: [{ agent: "repo-scout", prompt: "inspect" }, { agent: "oracle", prompt: "double-check" }] };
	assertAllowed(bugHunterAllowed, { primaryAgent: "bug-hunter" });
	assert.match(
		validateSubagentToolInput({ agent: "validator", prompt: "validate it" }, { primaryAgent: "bug-hunter" }),
		/TLH bug-hunter may delegate only to: repo-scout, librarian, oracle\. Disallowed target\(s\): validator\./,
	);

	const rushAllowed = {
		chain: [{ parallel: [{ agent: "code-reviewer", prompt: "review it", context: "fresh" }, { agent: "diff-summarizer", prompt: "summarize it" }] }],
	};
	assertAllowed(rushAllowed, { primaryAgent: "rush" });
	assert.match(
		validateSubagentToolInput({ agent: "validator", prompt: "validate it" }, { primaryAgent: "rush" }),
		/TLH rush may delegate only to: repo-scout, diff-summarizer, librarian, code-reviewer, oracle\. Disallowed target\(s\): validator\./,
	);
	assert.match(
		validateSubagentToolInput({ agent: "developer", prompt: "implement it" }, { primaryAgent: "rush" }),
		/TLH rush may delegate only to: repo-scout, diff-summarizer, librarian, code-reviewer, oracle\. Disallowed target\(s\): developer\./,
	);
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
