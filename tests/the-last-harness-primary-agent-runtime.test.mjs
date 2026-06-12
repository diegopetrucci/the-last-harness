import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { cleanupTempDir, createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { TLH_DEFAULT_COMMIT_ATTRIBUTION } = await jiti.import("../extensions/the-last-harness/attribution.ts");
const { RUN_TESTS_LAST_FEATURE } = await jiti.import("../extensions/the-last-harness/experimental.ts");
const { registerTlhPrimaryAgentRuntime } = await jiti.import("../extensions/the-last-harness/primary-agent-runtime.ts");

function createPiHarness() {
	const commands = new Map();
	const shortcuts = new Map();
	return {
		events: [],
		commands,
		shortcuts,
		activeTools: [],
		allTools: [{ name: "subagent" }],
		thinkingLevel: "normal",
		on(name, handler) {
			this.events.push({ name, handler });
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut(name, options) {
			shortcuts.set(name, options);
		},
		getAllTools() {
			return this.allTools;
		},
		getActiveTools() {
			return this.activeTools;
		},
		setActiveTools(tools) {
			this.activeTools = tools;
		},
		async setModel(model) {
			this.model = model;
			return true;
		},
		getThinkingLevel() {
			return this.thinkingLevel;
		},
		setThinkingLevel(level) {
			this.thinkingLevel = level;
		},
		appendEntry() {},
	};
}

function createToolCallContext(branchEntries = [], notifications, overrides = {}) {
	return {
		cwd: process.cwd(),
		sessionManager: { getBranch: () => branchEntries },
		ui: {
			notify(message, type = "info") {
				notifications?.push({ message, type });
			},
		},
		modelRegistry: {
			getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4" }],
		},
		model: { provider: "openai-codex", id: "gpt-5.4" },
		...overrides,
	};
}

function registerRuntimeHarness(options = {}) {
	const pi = createPiHarness();
	const runtime = registerTlhPrimaryAgentRuntime(pi, { env: {}, ...options });
	const beforeAgentStart = pi.events.find((event) => event.name === "before_agent_start")?.handler;
	const toolCall = pi.events.find((event) => event.name === "tool_call")?.handler;
	assert.equal(typeof beforeAgentStart, "function");
	assert.equal(typeof toolCall, "function");
	return { pi, runtime, beforeAgentStart, toolCall };
}


function writePrimaryConfig(agentDir, primaryAgent = {}) {
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ tlh: { primaryAgent } }, null, 2)}\n`);
}

function createPrimaryPrompt(name, overrides = {}) {
	return {
		name,
		description: "Test primary",
		tools: ["subagent"],
		systemPrompt: "test",
		filePath: `agents/primary/${name}.md`,
		...overrides,
	};
}

function selectablePrimaryAgents() {
	return new Map([
		["architect", createPrimaryPrompt("architect")],
		["rush", createPrimaryPrompt("rush")],
		["product", createPrimaryPrompt("product")],
		["bug-hunter", createPrimaryPrompt("bug-hunter")],
	]);
}

function rushLikePrimary(name = "architect") {
	return createPrimaryPrompt(name, {
		model: "anthropic/claude-opus-4-8",
		tlhOpenaiModels: ["openai-codex/gpt-5.5", "openai/gpt-5.5"],
		thinking: "low",
		tlhOpenaiThinking: "off",
		applyModel: true,
		applyThinking: true,
	});
}

function createCommandContext(branchEntries = [], overrides = {}) {
	const notifications = [];
	return { notifications, ctx: createToolCallContext(branchEntries, notifications, overrides) };
}

test("disabled primary mode still injects provider-aware subagent models", async () => {
	const { toolCall } = registerRuntimeHarness();
	const event = { toolName: "subagent", input: { agent: "developer", context: "resume" } };
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "disabled" } },
	]);

	assert.equal(await toolCall(event, ctx), undefined);
	assert.equal(event.input.model, "openai-codex/gpt-5.4");
	assert.equal(event.input.agentScope, undefined);
	assert.equal(event.input.context, "resume");
});

test("enabled primary mode validates subagent input after injecting provider-aware models", async () => {
	const { toolCall } = registerRuntimeHarness();
	const event = { toolName: "subagent", input: { agent: "developer", context: "resume" } };
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } },
	]);

	const result = await toolCall(event, ctx);
	assert.deepEqual(result, {
		block: true,
		reason:
			'TLH primary-agent subagent execution may not use context: "resume". TLH child sessions must start fresh so parent primary-agent/Gnosis context is not leaked.',
	});
	assert.equal(event.input.model, "openai-codex/gpt-5.4");
	assert.equal(event.input.agentScope, "user");
});

test("before_agent_start adds TLH commit attribution guidance only when enabled", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { beforeAgentStart } = registerRuntimeHarness();
		const enabledPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
		assert.match(enabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
		assert.match(enabledPrompt.systemPrompt, /Co-authored-by: The Last Harness <hi@thelastharness\.com>/);

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		const disabledPrompt = await beforeAgentStart(
			{ systemPrompt: "base prompt" },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.doesNotMatch(disabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
	});
});


test("before_agent_start gates run-tests-last experimental guidance behind isolated TLH settings", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { beforeAgentStart } = registerRuntimeHarness({ primaryAgents: selectablePrimaryAgents(), subagentMetadata: [] });
		const defaultPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
		assert.doesNotMatch(defaultPrompt.systemPrompt, /## TLH Experimental Feature: run-tests-last/);
		assert.doesNotMatch(defaultPrompt.systemPrompt, /separate final-validation ticket/i);
		assert.doesNotMatch(defaultPrompt.systemPrompt, /VALIDATING\.md.*otherwise use repo-discovered validation commands/i);

		for (const enabledFeatures of [true, [123]]) {
			writeFileSync(
				join(fixture.agent, "settings.json"),
				`${JSON.stringify({ tlh: { experimental: { enabledFeatures } } }, null, 2)}\n`,
			);
			const malformedPrompt = await beforeAgentStart(
				{ systemPrompt: "base prompt" },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			);
			assert.doesNotMatch(malformedPrompt.systemPrompt, /## TLH Experimental Feature: run-tests-last/);
			assert.doesNotMatch(malformedPrompt.systemPrompt, /separate final-validation ticket/i);
			assert.doesNotMatch(malformedPrompt.systemPrompt, /VALIDATING\.md.*otherwise use repo-discovered validation commands/i);
		}

		writeFileSync(
			join(fixture.agent, "settings.json"),
			`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [RUN_TESTS_LAST_FEATURE] } } }, null, 2)}\n`,
		);
		const enabledPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
		assert.match(enabledPrompt.systemPrompt, /## TLH Experimental Feature: run-tests-last/);
		assert.match(enabledPrompt.systemPrompt, /separate final-validation ticket/i);
		assert.match(enabledPrompt.systemPrompt, /depends on all implementation tickets/i);
		assert.match(enabledPrompt.systemPrompt, /VALIDATING\.md.*otherwise use repo-discovered validation commands/i);
		assert.match(enabledPrompt.systemPrompt, /Make any validation deferral explicit in the ticket text/i);
	});
});

test("child mode keeps parent-only controls disabled while applying commit attribution prompt and bash guard", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		const runtime = registerTlhPrimaryAgentRuntime(pi, { env: { PI_SUBAGENT_CHILD: "1" } });
		assert.equal(runtime, undefined);
		assert.deepEqual([...pi.commands.keys()], []);
		assert.deepEqual([...pi.shortcuts.keys()], []);
		assert.deepEqual(
			pi.events.map((event) => event.name),
			["before_agent_start", "tool_call"],
		);

		const beforeAgentStart = pi.events.find((event) => event.name === "before_agent_start")?.handler;
		const toolCall = pi.events.find((event) => event.name === "tool_call")?.handler;
		assert.equal(typeof beforeAgentStart, "function");
		assert.equal(typeof toolCall, "function");

		const enabledPrompt = await beforeAgentStart(
			{ systemPrompt: "base prompt" },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.match(enabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
		assert.match(enabledPrompt.systemPrompt, /Co-authored-by: The Last Harness <hi@thelastharness\.com>/);

		const blockedCommit = await toolCall(
			{ toolName: "bash", input: { command: 'git commit -m "ship it"' } },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.equal(blockedCommit?.block, true);
		assert.match(blockedCommit?.reason ?? "", /TLH attribution footer/);

		const childSubagentCall = { toolName: "subagent", input: { agent: "developer", context: "resume" } };
		assert.equal(await toolCall(childSubagentCall, createToolCallContext([], undefined, { cwd: fixture.cwd })), undefined);
		assert.equal(childSubagentCall.input.agentScope, undefined);
		assert.equal(childSubagentCall.input.context, "resume");

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		const disabledPrompt = await beforeAgentStart(
			{ systemPrompt: "base prompt" },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.doesNotMatch(disabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: 'git commit -m "ship it"' } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
	});
});

test("tool_call blocks obvious unattributed bash git commits only when attribution is enabled", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const [footerHeading, footerCoAuthor] = TLH_DEFAULT_COMMIT_ATTRIBUTION.split("\n\n");
	const attributedHereDoc = `git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;
	const wrappedAttributedHereDoc = `if true; then git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF\nfi`;
	const attributedWrappedInlineMessage = `bash -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedWrappedInlineMessageWithTerminator = `bash -lc -- 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedWrappedSplitMessage = `sh -c 'git commit -m "subject" -m "${footerHeading}" -m "${footerCoAuthor}"'`;
	const attributedWrappedSplitMessageWithTerminator = `sh -c -- 'git commit -m "subject" -m "${footerHeading}" -m "${footerCoAuthor}"'`;
	const attributedEnvInlineMessage = `env FOO=bar git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedQualifiedEnvInlineMessage = `/usr/bin/env FOO=bar git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedUnsetEnvInlineMessage = `env --unset=FOO git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedPathEnvInlineMessage = `env -P /usr/bin git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedUnsupportedEnvInlineMessage = `env -x git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedUnsupportedEnvWrappedInlineMessage = `env -x bash -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attachedSplitStringCommit = `env -S'git commit -m "ship it"'`;
	const shortAttachedSplitStringCombinedCommit = 'env -Sgit commit -m "ship it"';
	const shortQuotedSplitStringCombinedCommit = `env -S'git' commit -m "ship it"`;
	const shortQuotedSplitStringCommandCommit = `env -S'git commit' -m "ship it"`;
	const longSeparatedSplitStringCombinedCommit = 'env --split-string git commit -m "ship it"';
	const longAttachedSplitStringCombinedCommit = 'env --split-string=git commit -m "ship it"';
	const longQuotedSplitStringCombinedCommit = `env --split-string='git' commit -m "ship it"`;
	const shortQuotedSplitStringWrappedCommit = `env -S'bash -lc' 'git commit -m "ship it"'`;
	const shortQuotedSplitStringWrappedCommitWithTerminator = `env -S'bash -lc' -- 'git commit -m "ship it"'`;
	const longQuotedSplitStringWrappedCommit = `env --split-string='bash -lc' 'git commit -m "ship it"'`;
	const optionTerminatedSplitStringCommit = 'env -S -- git commit -m "ship it"';
	const optionTerminatedSplitStringWrappedCommit = `env --split-string='--' bash -lc 'git commit -m "ship it"'`;
	const unattributedUnsupportedEnvWrappedInlineMessage = `env -x bash -lc 'git commit -m "ship it"'`;
	const attachedSplitStringNoCommit = `env -S'printf ok'`;
	const optionTerminatedSplitStringNoCommit = 'env -S -- printf ok';
	const optionTerminatedSplitStringWrappedNoCommit = `env --split-string='--' bash -lc 'printf ok'`;
	const wrappedNoCommitWithTerminator = `bash -lc -- 'printf ok'`;
	const splitWrappedNoCommitWithTerminator = `env -S'bash -lc' -- 'printf ok'`;
	const unsupportedEnvWrappedNoCommit = `env -x bash -lc 'printf ok'`;
	const attributedSplitStringCombinedCommit = `env -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedLongSeparatedSplitStringCombinedCommit = `env --split-string git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedLongQuotedSplitStringCombinedCommit = `env --split-string='git' commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedShortQuotedSplitStringWrappedCommit = `env -S'bash -lc' 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShortQuotedSplitStringWrappedCommitWithTerminator = `env -S'bash -lc' -- 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedLongQuotedSplitStringWrappedCommit = `env --split-string='bash -lc' 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedOptionTerminatedSplitStringCommit = `env -S -- git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedOptionTerminatedSplitStringWrappedCommit = `env --split-string='--' bash -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShellOptionWrappedInlineMessage = `bash -o pipefail -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShellOptionWrappedInlineMessageWithTerminator = `bash -o pipefail -lc -- 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedProcessSubstitution = `git commit -F <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;
	const attributedPrintfEscapedNewlineProcessSubstitution = `git commit -F <(printf '%s\\n' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;
	const attributedEchoProcessSubstitution = `git commit -F <(echo "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;
	const unattributedWrappedProcessSubstitution = `bash -lc 'git commit -F <(printf "%s" subject || printf "%s" "${TLH_DEFAULT_COMMIT_ATTRIBUTION}")'`;
	const unattributedProcessSubstitution = `git commit -F <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nextra")`;
	const unattributedPrintfFormatProcessSubstitution = `git commit -F <(printf 'subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}extra')`;
	const unattributedPrintfArgsProcessSubstitution = `git commit -F <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}" extra)`;
	const attributedHereDocProcessSubstitution = `git commit -F <(cat <<'EOF'
subject

${TLH_DEFAULT_COMMIT_ATTRIBUTION}
EOF
)`;
	const unattributedHereDocProcessSubstitution = `git commit -F <(cat <<'EOF'
subject

${TLH_DEFAULT_COMMIT_ATTRIBUTION}

extra
EOF
)`;
	const unattributedTrailingOutputProcessSubstitution = `git commit -F <(cat <<'EOF'
subject

${TLH_DEFAULT_COMMIT_ATTRIBUTION}
EOF
printf 'extra'
)`;
	const unattributedWrongFileProcessSubstitution = `git commit -F <(printf '%s' subject) <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;
	const unattributedLastFileProcessSubstitution = `git commit -F <(printf '%s' "${TLH_DEFAULT_COMMIT_ATTRIBUTION}") -F <(printf '%s' subject)`;
	const attributedLastFileProcessSubstitution = `git commit -F <(printf '%s' subject) -F <(printf '%s' "${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of [
			'git commit -m "ship it"',
			'git -C repo commit -m "ship it"',
			'git commit -F-',
			'if true; then git commit -m "ship it"; fi',
			'if false; then :; else git commit -m "ship it"; fi',
			'for f in x; do git commit -m "ship it"; done',
			'! git commit -m "ship it"',
			'if git commit -m "ship it"; then echo done; fi',
			'command git commit -m "ship it"',
			'FOO=bar git commit -m "ship it"',
			'env FOO=bar git commit -m "ship it"',
			'/usr/bin/env FOO=bar git commit -m "ship it"',
			'env --unset=FOO git commit -m "ship it"',
			'env --chdir=repo git commit -m "ship it"',
			'env -P /usr/bin git commit -m "ship it"',
			`env -S 'git commit -m "ship it"'`,
			attachedSplitStringCommit,
			shortAttachedSplitStringCombinedCommit,
			shortQuotedSplitStringCombinedCommit,
			shortQuotedSplitStringCommandCommit,
			longSeparatedSplitStringCombinedCommit,
			longAttachedSplitStringCombinedCommit,
			longQuotedSplitStringCombinedCommit,
			shortQuotedSplitStringWrappedCommit,
			shortQuotedSplitStringWrappedCommitWithTerminator,
			longQuotedSplitStringWrappedCommit,
			optionTerminatedSplitStringCommit,
			optionTerminatedSplitStringWrappedCommit,
			'env -x git commit -m "ship it"',
			unattributedUnsupportedEnvWrappedInlineMessage,
			`bash -lc 'git commit -m "ship it"'`,
			`bash -lc -- 'git commit -m "ship it"'`,
			`sh -c 'git commit -m "ship it"'`,
			`sh -c -- 'git commit -m "ship it"'`,
			`bash -o pipefail -lc 'git commit -m "ship it"'`,
			`bash -o pipefail -lc -- 'git commit -m "ship it"'`,
			unattributedWrappedProcessSubstitution,
			unattributedProcessSubstitution,
			unattributedPrintfFormatProcessSubstitution,
			unattributedPrintfArgsProcessSubstitution,
			unattributedHereDocProcessSubstitution,
			unattributedTrailingOutputProcessSubstitution,
			unattributedWrongFileProcessSubstitution,
			unattributedLastFileProcessSubstitution,
		]) {
			const blocked = await toolCall(
				{ toolName: "bash", input: { command } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			);
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}
		assert.equal(
			await toolCall({ toolName: "bash", input: { command: attributedHereDoc } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedWrappedInlineMessage } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedWrappedInlineMessageWithTerminator } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedWrappedSplitMessage } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedWrappedSplitMessageWithTerminator } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedEnvInlineMessage } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedQualifiedEnvInlineMessage } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedUnsetEnvInlineMessage } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedPathEnvInlineMessage } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedUnsupportedEnvInlineMessage } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedUnsupportedEnvWrappedInlineMessage } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedSplitStringCombinedCommit } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedLongSeparatedSplitStringCombinedCommit } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedLongQuotedSplitStringCombinedCommit } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedShortQuotedSplitStringWrappedCommit } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedShortQuotedSplitStringWrappedCommitWithTerminator } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedLongQuotedSplitStringWrappedCommit } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedOptionTerminatedSplitStringCommit } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedOptionTerminatedSplitStringWrappedCommit } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedShellOptionWrappedInlineMessage } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedShellOptionWrappedInlineMessageWithTerminator } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: wrappedAttributedHereDoc } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedProcessSubstitution } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedPrintfEscapedNewlineProcessSubstitution } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedEchoProcessSubstitution } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedHereDocProcessSubstitution } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		assert.equal(
			await toolCall(
				{ toolName: "bash", input: { command: attributedLastFileProcessSubstitution } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			),
			undefined,
		);
		const mixedCommits = await toolCall(
			{ toolName: "bash", input: { command: `${attributedHereDoc}\ngit commit -m "ship it"` } },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.equal(mixedCommits?.block, true);
		assert.match(mixedCommits?.reason ?? "", /TLH attribution footer/);
		assert.equal(
			await toolCall({ toolName: "bash", input: { command: 'git commit -F .git/COMMIT_EDITMSG' } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
			undefined,
		);
		for (const command of [
			'env -P /usr/bin printf ok',
			`env -S 'printf ok'`,
			attachedSplitStringNoCommit,
			optionTerminatedSplitStringNoCommit,
			optionTerminatedSplitStringWrappedNoCommit,
			wrappedNoCommitWithTerminator,
			splitWrappedNoCommitWithTerminator,
			'env -x printf ok',
			unsupportedEnvWrappedNoCommit,
			`sh -c -- 'printf ok'`,
			`bash -o pipefail -lc 'printf ok'`,
			`bash -o pipefail -lc -- 'printf ok'`,
		]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		for (const command of [
			'if true; then git commit -m "ship it"; fi',
			'if git commit -m "ship it"; then echo done; fi',
			'command git commit -m "ship it"',
			'FOO=bar git commit -m "ship it"',
			'env FOO=bar git commit -m "ship it"',
			'/usr/bin/env FOO=bar git commit -m "ship it"',
			'env --unset=FOO git commit -m "ship it"',
			'env -P /usr/bin git commit -m "ship it"',
			`env -S 'git commit -m "ship it"'`,
			attachedSplitStringCommit,
			shortAttachedSplitStringCombinedCommit,
			shortQuotedSplitStringCombinedCommit,
			shortQuotedSplitStringCommandCommit,
			longSeparatedSplitStringCombinedCommit,
			longAttachedSplitStringCombinedCommit,
			longQuotedSplitStringCombinedCommit,
			shortQuotedSplitStringWrappedCommit,
			shortQuotedSplitStringWrappedCommitWithTerminator,
			longQuotedSplitStringWrappedCommit,
			optionTerminatedSplitStringCommit,
			optionTerminatedSplitStringWrappedCommit,
			'env -x git commit -m "ship it"',
			unattributedUnsupportedEnvWrappedInlineMessage,
			`bash -lc 'git commit -m "ship it"'`,
			`bash -lc -- 'git commit -m "ship it"'`,
			`sh -c 'git commit -m "ship it"'`,
			`sh -c -- 'git commit -m "ship it"'`,
			`bash -o pipefail -lc 'git commit -m "ship it"'`,
			`bash -o pipefail -lc -- 'git commit -m "ship it"'`,
		]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
	});
});

test("tool_call consumes separated message values before pathspec parsing", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const separatedShortMessageValue = "git commit -m --";
	const separatedLongMessageValue = "git commit --message --";
	const separatedShortMessageValueWithFooter = `git commit -m -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const separatedLongMessageValueWithFooter = `git commit --message -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const separatedShortMessageValueWithPathspecTerminator = `git commit -m -- -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const separatedLongMessageValueWithPathspecTerminator = `git commit --message -- -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of [separatedShortMessageValue, separatedLongMessageValue, separatedShortMessageValueWithPathspecTerminator, separatedLongMessageValueWithPathspecTerminator]) {
			const blocked = await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}
		for (const command of [separatedShortMessageValueWithFooter, separatedLongMessageValueWithFooter]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		for (const command of [
			separatedShortMessageValue,
			separatedLongMessageValue,
			separatedShortMessageValueWithFooter,
			separatedLongMessageValueWithFooter,
			separatedShortMessageValueWithPathspecTerminator,
			separatedLongMessageValueWithPathspecTerminator,
		]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
	});
});

test("tool_call ignores commit-message/file lookalikes after a pathspec terminator", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const attributedPathspecCommit = `git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}" -- README.md`;
	const misattributedPathspecMessage = `git commit -m subject -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const pathspecMessageLookalike = `git commit -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const pathspecFileLookalike = `git commit -- -F <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		const blocked = await toolCall(
			{ toolName: "bash", input: { command: misattributedPathspecMessage } },
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		for (const command of [attributedPathspecCommit, 'git commit -- README.md', pathspecMessageLookalike, pathspecFileLookalike]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		for (const command of [misattributedPathspecMessage, pathspecMessageLookalike, pathspecFileLookalike]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
	});
});

test("tool_call preserves heredoc context through shell wrapper recursion", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const attributedWrappedHereDoc = `bash -lc 'git commit -F -' <<'EOF'
subject

${TLH_DEFAULT_COMMIT_ATTRIBUTION}
EOF`;
	const unattributedWrappedHereDoc = `bash -lc 'git commit -F -' <<'EOF'
subject
EOF`;
	const attributedEnvSplitWrappedHereDoc = `env -S'bash -lc' 'git commit -F -' <<'EOF'
subject

${TLH_DEFAULT_COMMIT_ATTRIBUTION}
EOF`;
	const unattributedEnvSplitWrappedHereDoc = `env -S'bash -lc' 'git commit -F -' <<'EOF'
subject
EOF`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of [attributedWrappedHereDoc, attributedEnvSplitWrappedHereDoc]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
		for (const command of [unattributedWrappedHereDoc, unattributedEnvSplitWrappedHereDoc]) {
			const blocked = await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		for (const command of [unattributedWrappedHereDoc, unattributedEnvSplitWrappedHereDoc]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
	});
});

test("tool_call treats env unknown-option tails with consumed terminators as attribution-aware", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const attributedInlineCommand = `env -x -- git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedWrappedCommand = `env -x -- bash -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const misattributedInlineCommand = `env -x -- git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nextra"`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of [
			'env -x -- git commit -m "ship it"',
			`env -x -- bash -lc 'git commit -m "ship it"'`,
			misattributedInlineCommand,
		]) {
			const blocked = await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}
		for (const command of [attributedInlineCommand, attributedWrappedCommand, 'env -x -- printf ok']) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		for (const command of ['env -x -- git commit -m "ship it"', `env -x -- bash -lc 'git commit -m "ship it"'`]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
	});
});

test("tool_call reapplies env parsing after split-string expansion", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const attributedSplitStringUnsetCommand = `env --split-string -u FOO git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedAttachedSplitStringUnsetCommand = `env --split-string='-u FOO git commit' -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedSplitStringWrappedCommand = `env -S '-P /usr/bin bash -lc' 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedSplitStringGitCommand = `env -S '-P /usr/bin git' commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of [
			'env --split-string -u FOO git commit -m "ship it"',
			`env --split-string='-u FOO git commit' -m "ship it"`,
			`env -S '-P /usr/bin bash -lc' 'git commit -m "ship it"'`,
			`env -S '-P /usr/bin git' commit -m "ship it"`,
		]) {
			const blocked = await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}
		for (const command of [
			attributedSplitStringUnsetCommand,
			attributedAttachedSplitStringUnsetCommand,
			attributedSplitStringWrappedCommand,
			attributedSplitStringGitCommand,
			'env --split-string -u FOO printf ok',
			`env -S '-P /usr/bin bash -lc' 'printf ok'`,
		]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		for (const command of [
			'env --split-string -u FOO git commit -m "ship it"',
			`env --split-string='-u FOO git commit' -m "ship it"`,
			`env -S '-P /usr/bin bash -lc' 'git commit -m "ship it"'`,
			`env -S '-P /usr/bin git' commit -m "ship it"`,
		]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
	});
});

test("tool_call allows supported env split-string pathspec lookalikes while still blocking real inline options", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const pathspecLookalikes = [
		`env -S 'git commit -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`,
		`env -S 'git commit -- README.md'`,
		`env -S 'git commit' -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`,
	];
	const blockedInlineCommands = [
		`env -S 'git commit' -m "ship it"`,
		`env --split-string='git commit' -F - <<EOF\nship it\nEOF`,
	];
	const attributedInlineCommands = [
		`env -S 'git commit' -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`,
		`env --split-string='git commit' -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`,
	];

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of blockedInlineCommands) {
			const blocked = await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}
		for (const command of [...pathspecLookalikes, ...attributedInlineCommands]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		for (const command of [...blockedInlineCommands, ...pathspecLookalikes, ...attributedInlineCommands]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
	});
});

test("tool_call parses bash plus options and env short-option clusters before split-string payloads", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const misattributedShellPlusOptionWrappedCommand = `bash +o pipefail -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nextra"'`;
	const attributedShellPlusOptionWrappedCommand = `bash +o pipefail -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShellPlusShoptWrappedCommand = `bash +O extglob -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShellSimplePlusOptionWrappedCommand = `bash +e -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShellTracePlusOptionWrappedCommand = `bash +x -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const misattributedEnvShortClusterSplitStringCommand = `env -iSgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nextra"`;
	const attributedEnvShortClusterSplitStringCommand = `env -iSgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvVerboseShortClusterSplitStringCommand = `env -ivSgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvAttachedChdirSplitStringCommand = `env -C/tmp -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvAttachedUnsetSplitStringCommand = `env -uFOO -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvShortClusterUnsetSplitStringCommand = `env -iuFOO -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of [
			`bash +o pipefail -lc 'git commit -m "ship it"'`,
			`bash +O extglob -lc 'git commit -m "ship it"'`,
			`bash +e -lc 'git commit -m "ship it"'`,
			`bash +x -lc 'git commit -m "ship it"'`,
			misattributedShellPlusOptionWrappedCommand,
			'env -iSgit commit -m "ship it"',
			misattributedEnvShortClusterSplitStringCommand,
			'env -ivSgit commit -m "ship it"',
			'env -C/tmp -Sgit commit -m "ship it"',
			'env -uFOO -Sgit commit -m "ship it"',
			'env -iuFOO -Sgit commit -m "ship it"',
		]) {
			const blocked = await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}
		for (const command of [
			attributedShellPlusOptionWrappedCommand,
			attributedShellPlusShoptWrappedCommand,
			attributedShellSimplePlusOptionWrappedCommand,
			attributedShellTracePlusOptionWrappedCommand,
			attributedEnvShortClusterSplitStringCommand,
			attributedEnvVerboseShortClusterSplitStringCommand,
			attributedEnvAttachedChdirSplitStringCommand,
			attributedEnvAttachedUnsetSplitStringCommand,
			attributedEnvShortClusterUnsetSplitStringCommand,
			'env -iSprintf ok',
			'env -ivSprintf ok',
			`bash +o pipefail -lc 'printf ok'`,
			`bash +O extglob -lc 'printf ok'`,
			`bash +e -lc 'printf ok'`,
			`bash +x -lc 'printf ok'`,
		]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		for (const command of [
			`bash +o pipefail -lc 'git commit -m "ship it"'`,
			`bash +O extglob -lc 'git commit -m "ship it"'`,
			`bash +e -lc 'git commit -m "ship it"'`,
			`bash +x -lc 'git commit -m "ship it"'`,
			'env -iSgit commit -m "ship it"',
			'env -ivSgit commit -m "ship it"',
			'env -C/tmp -Sgit commit -m "ship it"',
			'env -uFOO -Sgit commit -m "ship it"',
			'env -iuFOO -Sgit commit -m "ship it"',
		]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
	});
});

test("tool_call parses env argv0 value options across separated, attached, and clustered forms", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const attributedEnvArgv0SeparatedCommand = `env -a name git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvArgv0AttachedCommand = `env -aname git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvLongArgv0SeparatedCommand = `env --argv0 name git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvLongArgv0AttachedCommand = `env --argv0=name git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvArgv0ClusteredSplitStringCommand = `env -iva name -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of [
			'env -a name git commit -m "ship it"',
			'env -aname git commit -m "ship it"',
			'env --argv0 name git commit -m "ship it"',
			'env --argv0=name git commit -m "ship it"',
			'env -iva name -Sgit commit -m "ship it"',
		]) {
			const blocked = await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}
		for (const command of [
			attributedEnvArgv0SeparatedCommand,
			attributedEnvArgv0AttachedCommand,
			attributedEnvLongArgv0SeparatedCommand,
			attributedEnvLongArgv0AttachedCommand,
			attributedEnvArgv0ClusteredSplitStringCommand,
			'env -a name printf ok',
			'env --argv0 name printf ok',
			'env --argv0=name printf ok',
			'env -iva name -Sprintf ok',
		]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		for (const command of [
			'env -a name git commit -m "ship it"',
			'env -aname git commit -m "ship it"',
			'env --argv0 name git commit -m "ship it"',
			'env --argv0=name git commit -m "ship it"',
			'env -iva name -Sgit commit -m "ship it"',
		]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
	});
});

test("tool_call inspects stdin here-docs through env unknown-option and split-string paths", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const attributedUnsupportedEnvHereDoc = `env -x -- git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;
	const attributedSplitStringHereDoc = `env -S 'git commit -F -' <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of [
			'env -x -- git commit -F - <<EOF\nship it\nEOF',
			`env -S 'git commit -F -' <<EOF\nship it\nEOF`,
		]) {
			const blocked = await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd }));
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}
		for (const command of [attributedUnsupportedEnvHereDoc, attributedSplitStringHereDoc]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}

		writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`);
		for (const command of [
			'env -x -- git commit -F - <<EOF\nship it\nEOF',
			`env -S 'git commit -F -' <<EOF\nship it\nEOF`,
		]) {
			assert.equal(
				await toolCall({ toolName: "bash", input: { command } }, createToolCallContext([], undefined, { cwd: fixture.cwd })),
				undefined,
			);
		}
	});
});

test("tool_call blocks process substitutions with top-level conditional operators", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		const blocked = await toolCall(
			{
				toolName: "bash",
				input: { command: `git commit -F <(printf '%s' subject || printf '%s' "${TLH_DEFAULT_COMMIT_ATTRIBUTION}")` },
			},
			createToolCallContext([], undefined, { cwd: fixture.cwd }),
		);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /TLH attribution footer/);
	});
});

test("tool_call blocks non-progress printf process substitutions", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { toolCall } = registerRuntimeHarness();
		for (const command of [
			"git commit -F <(printf 'subject' extra)",
			"git commit -F <(printf '%%' extra)",
		]) {
			const blocked = await toolCall(
				{ toolName: "bash", input: { command } },
				createToolCallContext([], undefined, { cwd: fixture.cwd }),
			);
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /TLH attribution footer/);
		}
	});
});

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

test("enabled primary mode blocks disallowed nested delegation targets after forcing safe defaults", async () => {
	const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
	const event = {
		toolName: "subagent",
		input: {
			tasks: [{ agent: "repo-scout", prompt: "Inspect the repo" }],
			chain: [{ parallel: [{ agent: "planner", prompt: "Plan the work" }] }],
		},
	};
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } },
	]);

	assert.deepEqual(await toolCall(event, ctx), {
		block: true,
		reason:
			"TLH primary agents may delegate only to: developer, code-reviewer, repo-scout, diff-summarizer, librarian, web-scout, oracle. Disallowed target(s): planner.",
	});
	assert.equal(event.input.agentScope, "user");
	assert.equal(event.input.context, "fresh");
});

test("enabled primary mode normalizes safe management list/get scopes and blocks non-user management scopes", async () => {
	const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
	const ctx = createToolCallContext([
		{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "architect" } },
	]);
	const listEvent = { toolName: "subagent", input: { action: "list" } };
	const listBothEvent = { toolName: "subagent", input: { action: "list", agentScope: "both" } };
	const getEvent = { toolName: "subagent", input: { action: "get", agentScope: "" } };
	const getBothEvent = { toolName: "subagent", input: { action: "get", agentScope: "both" } };
	const blockedEvent = { toolName: "subagent", input: { action: "get", agentScope: "project" } };

	assert.equal(await toolCall(listEvent, ctx), undefined);
	assert.equal(listEvent.input.agentScope, "user");
	assert.equal(await toolCall(listBothEvent, ctx), undefined);
	assert.equal(listBothEvent.input.agentScope, "user");
	assert.equal(await toolCall(getEvent, ctx), undefined);
	assert.equal(getEvent.input.agentScope, "user");
	assert.equal(await toolCall(getBothEvent, ctx), undefined);
	assert.equal(getBothEvent.input.agentScope, "user");
	assert.deepEqual(await toolCall(blockedEvent, ctx), {
		block: true,
		reason: 'TLH primary-agent subagent get calls may not use agentScope: "project". TLH minor agents must run from the isolated user scope.',
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

test("primary runtime applies OpenAI Rush-like metadata defaults with no settings opt-in", async () => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);

	try {
		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
			assert.ok(runtime, "runtime should register outside child sessions");

			await runtime.applySessionStart({
				cwd: fixture.cwd,
				sessionManager: { getBranch: () => [] },
				ui: { notify() {} },
				modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.5" }] },
				model: { provider: "openai-codex", id: "gpt-5.4" },
			});

			assert.deepEqual(pi.model, { provider: "openai-codex", id: "gpt-5.5" });
			assert.equal(pi.thinkingLevel, "off");
		});
	} finally {
		cleanupTempDir(fixture);
	}
});

test("primary runtime falls back to Anthropic Rush-like metadata defaults when only Anthropic is available", async () => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);

	try {
		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
			assert.ok(runtime, "runtime should register outside child sessions");

			await runtime.applySessionStart({
				cwd: fixture.cwd,
				sessionManager: { getBranch: () => [] },
				ui: { notify() {} },
				modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
				model: { provider: "openai-codex", id: "gpt-5.4" },
			});

			assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
			assert.equal(pi.thinkingLevel, "low");
		});
	} finally {
		cleanupTempDir(fixture);
	}
});

test("primary runtime respects explicit false settings over Rush-like metadata defaults", async () => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
	const primaryAgents = new Map([["architect", rushLikePrimary()]]);

	try {
		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			writePrimaryConfig(fixture.agent, { applyModel: false, applyThinking: false });
			const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
			assert.ok(runtime, "runtime should register outside child sessions");

			await runtime.applySessionStart({
				cwd: fixture.cwd,
				sessionManager: { getBranch: () => [] },
				ui: { notify() {} },
				modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.5" }] },
				model: { provider: "openai-codex", id: "gpt-5.4" },
			});

			assert.equal(pi.model, undefined);
			assert.equal(pi.thinkingLevel, "normal");
		});
	} finally {
		cleanupTempDir(fixture);
	}
});

test("architect before_agent_start preserves medium floor selection but restores declared default after rush", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const architectPrimary = createPrimaryPrompt("architect", {
		model: "anthropic/claude-opus-4-8",
		thinking: "high",
		minThinking: "medium",
		applyModel: true,
		applyThinking: true,
	});
	const rushPrimary = createPrimaryPrompt("rush", {
		model: "anthropic/claude-opus-4-8",
		thinking: "low",
		applyModel: true,
		applyThinking: true,
		lockThinking: true,
	});
	const primaryAgents = new Map([
		["architect", architectPrimary],
		["rush", rushPrimary],
	]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		assert.ok(runtime, "runtime should register outside child sessions");

		const makeCtx = (branch) => ({
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => branch },
			ui: { notify() {} },
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: { provider: "anthropic", id: "claude-opus-4-8" },
		});

		await runtime.applySessionStart(makeCtx([]));
		assert.equal(pi.thinkingLevel, "high", "architect starts at its declared default");

		pi.thinkingLevel = "medium";
		await beforeAgentStart({ systemPrompt: "base prompt" }, makeCtx([]));
		assert.equal(pi.thinkingLevel, "medium", "before_agent_start preserves a current level that satisfies architect's floor");

		await beforeAgentStart(
			{ systemPrompt: "base prompt" },
			makeCtx([{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } }]),
		);
		assert.equal(pi.thinkingLevel, "low", "locked rush still forces low thinking");

		await beforeAgentStart({ systemPrompt: "base prompt" }, makeCtx([]));
		assert.equal(pi.thinkingLevel, "high", "architect restores its declared default after returning from rush");
	});
});

test("locked primary (rush) overrides global applyThinking=false and applyModel=false", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const rushPrimary = createPrimaryPrompt("rush", {
		model: "anthropic/claude-opus-4-8",
		thinking: "low",
		applyModel: true,
		applyThinking: true,
		lockThinking: true,
	});
	const primaryAgents = new Map([["rush", rushPrimary]]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		// Global opt-outs that the lock should override
		writePrimaryConfig(fixture.agent, { applyModel: false, applyThinking: false });

		const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		assert.ok(runtime, "runtime should register outside child sessions");

		// Use a different initial model so applyPrimaryModel actually calls setModel
		await runtime.applySessionStart({
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => [
				{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
			]},
			ui: { notify() {} },
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: { provider: "anthropic", id: "claude-opus-4-6" },
		});

		// lockThinking: true forces both model and thinking regardless of global opt-outs
		assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
		assert.equal(pi.thinkingLevel, "low");
	});
});

test("non-locked primary (architect) honors global applyThinking=false override", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
	const architectPrimary = createPrimaryPrompt("architect", {
		model: "anthropic/claude-opus-4-8",
		thinking: "high",
		applyModel: true,
		applyThinking: true,
		// no lockThinking
	});
	const primaryAgents = new Map([["architect", architectPrimary]]);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		// User opts out of thinking auto-apply for architect
		writePrimaryConfig(fixture.agent, { applyThinking: false });

		const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
		assert.ok(runtime, "runtime should register outside child sessions");

		await runtime.applySessionStart({
			cwd: fixture.cwd,
			sessionManager: { getBranch: () => [] },
			ui: { notify() {} },
			modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
			model: { provider: "anthropic", id: "claude-opus-4-8" },
		});

		// Global applyThinking: false is respected for non-locked primary
		assert.equal(pi.thinkingLevel, "normal");
	});
});
