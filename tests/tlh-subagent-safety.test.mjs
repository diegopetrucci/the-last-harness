import assert from "node:assert/strict";
import test from "node:test";

import {
	ALLOWED_SUBAGENTS,
	SAFE_SUBAGENT_ACTIONS,
	SUBAGENT_CHILD_ENV,
	allowedSubagentsForExperimentalConfig,
	isEmbeddedSubagentTarget,
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
	const webScout = { agent: "web-scout", task: "research the general web for upstream release notes" };
	assertAllowed(webScout);
	assert.equal(webScout.agentScope, "user");
	assert.equal(webScout.context, "fresh");

	const contrarian = { agent: "contrarian", task: "stress-test this plan by steelmanning the strongest opposing case" };
	assertAllowed(contrarian);
	assert.equal(contrarian.agentScope, "user");
	assert.equal(contrarian.context, "fresh");
});

test("experimental allowlist keeps contrarian enabled by default and treats stale settings as harmless no-ops", () => {
	assert.deepEqual(allowedSubagentsForExperimentalConfig(undefined), ALLOWED_SUBAGENTS);
	assert.deepEqual(allowedSubagentsForExperimentalConfig({ enabledFeatures: [" Contrarian "] }), ALLOWED_SUBAGENTS);
	assert.deepEqual(allowedSubagentsForExperimentalConfig({ enabledFeatures: ["Contrarian", 123] }), ALLOWED_SUBAGENTS);

	const defaultAllowed = { agent: "contrarian", task: "stress-test this plan" };
	assert.equal(validateSubagentToolInput(defaultAllowed), undefined);
	assert.equal(defaultAllowed.agentScope, "user");
	assert.equal(defaultAllowed.context, "fresh");

	const allowedWithLegacyFlag = { agent: "contrarian", task: "stress-test this plan" };
	assert.equal(
		validateSubagentToolInput(allowedWithLegacyFlag, {
			allowedSubagents: allowedSubagentsForExperimentalConfig({ enabledFeatures: ["contrarian"] }),
		}),
		undefined,
	);
	assert.equal(allowedWithLegacyFlag.agentScope, "user");
	assert.equal(allowedWithLegacyFlag.context, "fresh");
});


test("custom allowlists are bounded to canonical bundled subagents", () => {
	const customEnabled = { agent: "contrarian", task: "stress-test this plan" };
	assertAllowed(customEnabled, { allowedSubagents: [" Developer ", " CONTRARIAN ", "root"] });
	assert.equal(customEnabled.agentScope, "user");
	assert.equal(customEnabled.context, "fresh");

	assert.match(
		validateSubagentToolInput({ agent: "root", task: "do something unsafe" }, { allowedSubagents: ["developer", "root"] }),
		/Disallowed target\(s\): root/,
	);

	const emptyFallbackAllowed = { agent: "contrarian", task: "stress-test this plan" };
	assertAllowed(emptyFallbackAllowed, { allowedSubagents: [] });
	assert.equal(emptyFallbackAllowed.agentScope, "user");
	assert.equal(emptyFallbackAllowed.context, "fresh");

	const fallbackAllowed = { agent: "contrarian", task: "stress-test this plan" };
	assertAllowed(fallbackAllowed, { allowedSubagents: ["root", "system", ""] });
	assert.equal(fallbackAllowed.agentScope, "user");
	assert.equal(fallbackAllowed.context, "fresh");
});

test("validateSubagentToolInput allows approved execution and forces fresh user context", () => {
	const single = { agent: "developer", task: "implement the ticket" };
	assertAllowed(single);
	assert.equal(single.agentScope, "user");
	assert.equal(single.context, "fresh");

	const batched = {
		tasks: [
			{ agent: "repo-scout", task: "map the repo" },
			{ agent: "librarian", task: "research upstream docs" },
			{ agent: "code-reviewer", task: "review the diff", context: "fresh" },
			{ agent: "diff-summarizer", task: "summarize" },
			{ agent: "oracle", task: "provide a second opinion", context: "fresh" },
			{ agent: "developer", task: "fix one issue" },
			{ agent: "repo-scout", task: "inspect one area", context: "fresh" },
		],
	};
	assertAllowed(batched);
	assert.equal(batched.agentScope, "user");
	assert.equal(batched.context, "fresh");
});

test("SAFE_SUBAGENT_ACTIONS exposes exactly the supported management contract", () => {
	// steer was added by explicit policy decision (ts-hl1q); rush is blocked from steer as the compensating control.
	assert.deepEqual(SAFE_SUBAGENT_ACTIONS, ["list", "get", "status", "interrupt", "doctor", "resume", "steer"]);
});

test("validateSubagentToolInput allows approved management calls and keeps enabled resume normalization", () => {
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

test("validateSubagentToolInput allows opaque resume and blocks unsafe scopes/contexts", () => {
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

	const opaqueResume = { action: "resume", id: "run-123", message: "Continue with the approved ticket.", agentScope: "", context: "" };
	assertAllowed(opaqueResume);
	assert.equal(opaqueResume.agentScope, "user");
	assert.equal(opaqueResume.context, "fresh");

	const contrarianResume = { action: "resume", id: "run-456", message: "Continue with the approved ticket." };
	assertAllowed(contrarianResume, { resumeTargetAgent: " contrarian " });
	assert.equal(contrarianResume.agentScope, "user");
	assert.equal(contrarianResume.context, "fresh");

	const allowedDeveloperResume = { action: "resume", id: "run-789", message: "Continue with the approved ticket." };
	assertAllowed(allowedDeveloperResume, { resumeTargetAgent: " Developer " });
	assert.equal(allowedDeveloperResume.agentScope, "user");
	assert.equal(allowedDeveloperResume.context, "fresh");
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
		validateSubagentToolInput({ tasks: [{ agent: "repo-scout" }, { agent: "root" }] }),
		/Disallowed target\(s\): root/,
	);
});

test("isEmbeddedSubagentTarget accepts strict embedded.<slug> names and rejects malformed ones", () => {
	// Valid patterns
	assert.equal(isEmbeddedSubagentTarget("embedded.scout"), true);
	assert.equal(isEmbeddedSubagentTarget("embedded.scout-2"), true);
	assert.equal(isEmbeddedSubagentTarget("embedded.a"), true);
	assert.equal(isEmbeddedSubagentTarget("embedded.repo-helper"), true);
	assert.equal(isEmbeddedSubagentTarget("embedded.0helper"), true);

	// Malformed patterns
	assert.equal(isEmbeddedSubagentTarget("embedded."), false); // no slug
	assert.equal(isEmbeddedSubagentTarget("embedded.Scout"), false); // uppercase
	assert.equal(isEmbeddedSubagentTarget("embedded.Foo"), false); // uppercase
	assert.equal(isEmbeddedSubagentTarget("embedded.-x"), false); // leading dash
	assert.equal(isEmbeddedSubagentTarget("embedded.repo.helper"), false); // extra dot
	assert.equal(isEmbeddedSubagentTarget("embedded.repo_helper"), false); // underscore
	assert.equal(isEmbeddedSubagentTarget("x.embedded.y"), false); // wrong prefix
	assert.equal(isEmbeddedSubagentTarget("developer"), false); // no embedded prefix
	assert.equal(isEmbeddedSubagentTarget(""), false);
	assert.equal(isEmbeddedSubagentTarget(42), false);
});

test("validateSubagentToolInput with allowEmbeddedTargets:false (default) rejects embedded names like unknown agents", () => {
	// Flag off: embedded targets are rejected like any other unknown agent
	const reason = validateSubagentToolInput({ agent: "embedded.repo-helper" });
	assert.match(reason, /Disallowed target\(s\): embedded\.repo-helper/);

	// Error message does NOT mention embedded.<slug> when flag is off
	assert.doesNotMatch(reason, /or embedded\.<slug>/);

	// Malformed embedded names are also rejected
	assert.match(validateSubagentToolInput({ agent: "embedded.Repo-helper" }), /Disallowed target\(s\): embedded\.Repo-helper/);
	assert.match(validateSubagentToolInput({ agent: "embedded.repo.helper" }), /Disallowed target\(s\): embedded\.repo\.helper/);
	assert.match(validateSubagentToolInput({ agent: "embedded.-x" }), /Disallowed target\(s\): embedded\.-x/);
});

test("validateSubagentToolInput with allowEmbeddedTargets:true allows valid embedded targets in all execution shapes", () => {
	const opts = { allowEmbeddedTargets: true };

	// single
	const single = { agent: "embedded.repo-helper", prompt: "inspect the repo" };
	assertAllowed(single, opts);
	assert.equal(single.agentScope, "user");
	assert.equal(single.context, "fresh");

	// tasks (parallel batch)
	const tasks = { tasks: [{ agent: "embedded.parallel-helper", prompt: "inspect one area" }] };
	assertAllowed(tasks, opts);
	assert.equal(tasks.agentScope, "user");
	assert.equal(tasks.context, "fresh");

	// mixed: bundled + embedded
	const mixed = { tasks: [{ agent: "developer", prompt: "impl" }, { agent: "embedded.scout", prompt: "scout" }] };
	assertAllowed(mixed, opts);
});

test("validateSubagentToolInput with allowEmbeddedTargets:true rejects malformed embedded names", () => {
	const opts = { allowEmbeddedTargets: true };

	assert.match(validateSubagentToolInput({ agent: "embedded." }, opts), /Disallowed target\(s\): embedded\./);
	assert.match(validateSubagentToolInput({ agent: "embedded.Scout" }, opts), /Disallowed target\(s\): embedded\.Scout/);
	assert.match(validateSubagentToolInput({ agent: "embedded.repo.helper" }, opts), /Disallowed target\(s\): embedded\.repo\.helper/);
	assert.match(validateSubagentToolInput({ agent: "embedded.-x" }, opts), /Disallowed target\(s\): embedded\.-x/);
	assert.match(validateSubagentToolInput({ agent: "x.embedded.y" }, opts), /Disallowed target\(s\): x\.embedded\.y/);
});

test("validateSubagentToolInput error messages mention embedded.<slug> only when allowEmbeddedTargets is true", () => {
	// No targets at all: message with flag off
	const noTargetOff = validateSubagentToolInput({});
	assert.match(noTargetOff, /must target one of:/);
	assert.doesNotMatch(noTargetOff, /or embedded\.<slug>/);

	// No targets at all: message with flag on
	const noTargetOn = validateSubagentToolInput({}, { allowEmbeddedTargets: true });
	assert.match(noTargetOn, /must target one of:/);
	assert.match(noTargetOn, /or embedded\.<slug>/);

	// Disallowed target: message with flag off
	const disallowedOff = validateSubagentToolInput({ agent: "unknown-agent" });
	assert.match(disallowedOff, /may delegate only to:/);
	assert.doesNotMatch(disallowedOff, /or embedded\.<slug>/);

	// Disallowed target: message with flag on
	const disallowedOn = validateSubagentToolInput({ agent: "unknown-agent" }, { allowEmbeddedTargets: true });
	assert.match(disallowedOn, /may delegate only to:/);
	assert.match(disallowedOn, /or embedded\.<slug>/);
});

test("validateSubagentToolInput: allowEmbeddedTargets does not affect management action validation", () => {
	const opts = { allowEmbeddedTargets: true };

	// list/get/resume/status/interrupt/doctor behave identically regardless of flag
	const list = { action: "list" };
	assertAllowed(list, opts);
	assert.equal(list.agentScope, "user");

	const get = { action: "get", agentScope: "" };
	assertAllowed(get, opts);
	assert.equal(get.agentScope, "user");

	for (const action of ["status", "interrupt", "doctor"]) {
		assertAllowed({ action }, opts);
	}

	// Unsafe action still blocked
	assert.match(validateSubagentToolInput({ action: "delete" }, opts), /may not use subagent management action 'delete'/);
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
		validateSubagentToolInput({ tasks: [{ agent: "developer", context: "" }] }),
		/nested tasks\[0\]\.context may not use context: ""/,
	);
});

// Regression: upstream v0.34.0 added eject/disable/enable/reset management verbs that mutate
// agent definitions/overrides. TLH policy forbids runtime agent-definition mutation. These are
// blocked by the SAFE_SUBAGENT_ACTIONS whitelist on the tool_call path, which is the only way
// to reach these verbs. This test pins the behavior so a future whitelist change cannot
// silently allow any of these verbs.
test("validateSubagentToolInput blocks v0.34.0 agent-mutation verbs (eject/disable/enable/reset)", () => {
	// Each new verb must be rejected with a block reason.
	for (const action of ["eject", "disable", "enable", "reset"]) {
		const reason = validateSubagentToolInput({ action });
		assert.match(
			reason,
			/may not use subagent management action/,
			`expected block reason for action '${action}'`,
		);
		assert.match(reason, new RegExp(`'${action}'`), `reason should name the blocked action '${action}'`);
	}

	// The whitelist must remain exactly this set — no additions without an explicit policy decision.
	// steer was added by explicit policy decision (ts-hl1q); rush is blocked from steer as the compensating control
	// (rushSteerDelegationReason in primary-agent-runtime.ts) because an opaque steer carries no agent field.
	assert.deepEqual(
		[...SAFE_SUBAGENT_ACTIONS],
		["list", "get", "status", "interrupt", "doctor", "resume", "steer"],
		"SAFE_SUBAGENT_ACTIONS whitelist changed — verify TLH policy before widening",
	);
});

test("validateSubagentToolInput allows steer with valid id and message", () => {
	const steer = { action: "steer", id: "run-abc", message: "Please wrap up the current subtask." };
	assertAllowed(steer);
});

test("validateSubagentToolInput blocks steer without id", () => {
	assert.match(
		validateSubagentToolInput({ action: "steer", message: "Wrap up." }),
		/may not call steer without a non-empty string id/,
	);
	assert.match(
		validateSubagentToolInput({ action: "steer", id: "", message: "Wrap up." }),
		/may not call steer without a non-empty string id/,
	);
	assert.match(
		validateSubagentToolInput({ action: "steer", id: 42, message: "Wrap up." }),
		/may not call steer without a non-empty string id/,
	);
});

test("validateSubagentToolInput blocks steer without message", () => {
	assert.match(
		validateSubagentToolInput({ action: "steer", id: "run-abc" }),
		/may not call steer without a non-empty string message/,
	);
	assert.match(
		validateSubagentToolInput({ action: "steer", id: "run-abc", message: "" }),
		/may not call steer without a non-empty string message/,
	);
});

test("validateSubagentToolInput blocks steer with execution-bearing fields", () => {
	for (const field of ["agent", "tasks", "chain", "context", "agentScope"]) {
		const input = { action: "steer", id: "run-abc", message: "Wrap up.", [field]: "some-value" };
		const reason = validateSubagentToolInput(input);
		assert.match(
			reason,
			new RegExp(`may not include '${field}' on a steer call`),
			`expected steer to reject field '${field}'`,
		);
	}
});

test("validateSubagentToolInput blocks steer with non-integer or negative index", () => {
	assert.match(
		validateSubagentToolInput({ action: "steer", id: "run-abc", message: "Wrap up.", index: -1 }),
		/non-integer or negative index/,
	);
	assert.match(
		validateSubagentToolInput({ action: "steer", id: "run-abc", message: "Wrap up.", index: 1.5 }),
		/non-integer or negative index/,
	);
	assert.match(
		validateSubagentToolInput({ action: "steer", id: "run-abc", message: "Wrap up.", index: "0" }),
		/non-integer or negative index/,
	);
	// zero and positive integers should be allowed
	assertAllowed({ action: "steer", id: "run-abc", message: "Wrap up.", index: 0 });
	assertAllowed({ action: "steer", id: "run-abc", message: "Wrap up.", index: 3 });
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
