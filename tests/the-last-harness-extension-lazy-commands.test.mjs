import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

function createPiHarness() {
	const commands = new Map();
	const handlers = new Map();
	const sentMessages = [];
	let activeTools = [];
	return {
		commands,
		handlers,
		sentMessages,
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		sendMessage(message) {
			sentMessages.push(message);
		},
		registerShortcut() {},
		appendEntry() {},
		getAllTools: () => activeTools.map((name) => ({ name })),
		getActiveTools: () => activeTools,
		setActiveTools(tools) {
			activeTools = [...tools];
		},
		getThinkingLevel: () => "medium",
		setThinkingLevel() {},
		setModel: async () => true,
	};
}

function createCommandContext({ cwd, hasUI = false, branch = [] } = {}) {
	const notifications = [];
	const pasted = [];
	return {
		notifications,
		pasted,
		ctx: {
			cwd,
			hasUI,
			model: { provider: "anthropic", id: "claude-sonnet-4-20250514", contextWindow: 200000 },
			sessionManager: {
				getBranch: () => branch,
				getEntries: () => [],
				getCwd: () => cwd,
				getSessionName: () => undefined,
			},
			ui: {
				notify(message, type) {
					notifications.push({ message, type });
				},
				getEditorText: () => pasted.join(""),
				pasteToEditor(text) {
					pasted.push(text);
				},
			},
		},
	};
}

function restoreEnv(previousEnv) {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

test("Jiti command facades resolve review, tokens, annotate-last-message, and tlh-changelog at runtime without extra shutdown listeners", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "tlh-lazy-commands-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "workspace");
	const previousEnv = {
		PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
		PI_SUBAGENT_CHILD_AGENT: process.env.PI_SUBAGENT_CHILD_AGENT,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
	};

	try {
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env.PI_SUBAGENT_CHILD_AGENT;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.TLH_SKIP_UPDATE_CHECK = "1";
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ tlh: { primaryAgent: { enabled: true, selected: "architect" }, updateCheck: { enabled: false } } }, null, 2)}\n`,
		);

		const jiti = createJiti(import.meta.url, { moduleCache: false });
		const { default: theLastHarness } = await jiti.import("../extensions/the-last-harness.ts");
		const pi = createPiHarness();
		theLastHarness(pi);

		const reviewCommand = pi.commands.get("review");
		const tokensCommand = pi.commands.get("tokens");
		const annotateCommand = pi.commands.get("annotate-last-message");
		const changelogCommand = pi.commands.get("tlh-changelog");
		assert.equal(typeof reviewCommand?.handler, "function");
		assert.equal(reviewCommand?.getArgumentCompletions?.("anything"), null);
		assert.equal(typeof tokensCommand?.handler, "function");
		assert.equal(typeof annotateCommand?.handler, "function");
		assert.equal(typeof changelogCommand?.handler, "function");

		const shutdownHandlerCount = pi.handlers.get("session_shutdown")?.length ?? 0;

		const reviewRun = createCommandContext({ cwd });
		await reviewCommand.handler("pr 123", reviewRun.ctx);
		assert.deepEqual(reviewRun.notifications, [
			{
				message:
					"/review is picker-only. Run /review with no arguments, then choose a mode in the picker. Typed shortcuts like `/review pr 123` and `--extra` are no longer supported.",
				type: "error",
			},
		]);

		const tokensRun = createCommandContext({ cwd });
		await tokensCommand.handler("unexpected", tokensRun.ctx);
		assert.deepEqual(tokensRun.notifications, [{ message: "Usage: /tokens", type: "error" }]);

		const annotateRun = createCommandContext({ cwd });
		await annotateCommand.handler("", annotateRun.ctx);
		await annotateCommand.handler("", annotateRun.ctx);
		assert.deepEqual(annotateRun.notifications, [
			{ message: "annotate-last-message requires interactive mode.", type: "error" },
			{ message: "annotate-last-message requires interactive mode.", type: "error" },
		]);

		const changelogRun = createCommandContext({ cwd });
		await changelogCommand.handler("", changelogRun.ctx);
		assert.equal(changelogRun.notifications.length, 0);
		assert.equal(pi.sentMessages.length, 1);
		assert.equal(pi.sentMessages[0]?.customType, "TLH release notes");
		assert.equal(pi.sentMessages[0]?.display, true);
		assert.equal(pi.sentMessages[0]?.details?.title, "TLH Release Notes");
		assert.match(pi.sentMessages[0]?.content ?? "", /^# /m);

		assert.equal(
			pi.handlers.get("session_shutdown")?.length ?? 0,
			shutdownHandlerCount,
			"lazy annotate invocations must not register extra shutdown listeners",
		);

		for (const handler of pi.handlers.get("session_shutdown") ?? []) {
			await handler({}, annotateRun.ctx);
		}
	} finally {
		restoreEnv(previousEnv);
		rmSync(tempDir, { recursive: true, force: true });
	}
});
