import assert from "node:assert/strict";
import test from "node:test";

import {
	ALLOWED_SUBAGENTS,
	SUBAGENT_CHILD_ENV,
	isAllowedSubagentTarget,
	isEmbeddedSubagentTarget,
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

test("embedded target helpers accept strict embedded.<slug> names only", () => {
	assert.equal(isEmbeddedSubagentTarget("embedded.scout"), true);
	assert.equal(isEmbeddedSubagentTarget("embedded.scout-2"), true);
	assert.equal(isEmbeddedSubagentTarget("embedded.scout.extra"), false);
	assert.equal(isEmbeddedSubagentTarget("embedded.Scout"), false);
	assert.equal(isEmbeddedSubagentTarget("embedded._scout"), false);
	assert.equal(isAllowedSubagentTarget("developer"), true);
	assert.equal(isAllowedSubagentTarget("embedded.scout"), true);
	assert.equal(isAllowedSubagentTarget("embedded.scout.extra"), false);
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

test("validateSubagentToolInput allows strict embedded targets in single, parallel, and chain execution", () => {
	for (const input of [
		{ agent: "embedded.repo-helper", prompt: "inspect the repo" },
		{ tasks: [{ agent: "embedded.parallel-helper", prompt: "inspect one area" }] },
		{ chain: [{ agent: "embedded.chain-helper", prompt: "continue the work" }] },
	]) {
		assertAllowed(input);
		assert.equal(input.agentScope, "user");
		assert.equal(input.context, "fresh");
	}
});

test("validateSubagentToolInput allows approved management calls and forces user scope where needed", () => {
	const list = { action: "list" };
	assertAllowed(list);
	assert.equal(list.agentScope, "user");

	const bundledGet = { action: "get", agent: "developer", agentScope: "" };
	assertAllowed(bundledGet);
	assert.equal(bundledGet.agentScope, "user");

	const embeddedGet = { action: "get", agent: "embedded.repo-helper" };
	assertAllowed(embeddedGet);
	assert.equal(embeddedGet.agentScope, "user");

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
	assert.match(validateSubagentToolInput({ action: "get", chainName: "review-flow" }), /may not use subagent chain management via chainName/);
	assert.match(validateSubagentToolInput({ action: "get" }), /must specify agent/);
	assert.match(validateSubagentToolInput({ action: "get", agent: "embedded.repo.helper" }), /Disallowed target: embedded\.repo\.helper/);
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
	assert.match(validateSubagentToolInput({ agent: "embedded.repo.helper" }), /Disallowed target\(s\): embedded\.repo\.helper/);
	assert.match(validateSubagentToolInput({ agent: "embedded.Repo-helper" }), /Disallowed target\(s\): embedded\.Repo-helper/);
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
