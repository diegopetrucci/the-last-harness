import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerTlhTicketWorkflowUi } = await jiti.import("../extensions/the-last-harness/ticket-workflow-ui.ts");
const { TICKET_WORKFLOW_UI_FEATURE } = await jiti.import("../extensions/the-last-harness/experimental.ts");

const READY_TICKET_TITLE = "Implement read-only - ticket workflow status UI";
const READY_TICKET_FOOTER_STATUS = `working on tk: ${READY_TICKET_TITLE}\nUse /tk-status for details.`;

function createPiHarness() {
	const commands = new Map();
	const handlers = new Map();
	const eventBusHandlers = new Map();
	return {
		commands,
		handlers,
		events: {
			on(event, handler) {
				eventBusHandlers.set(event, [...(eventBusHandlers.get(event) ?? []), handler]);
			},
			emit(event, payload) {
				for (const handler of eventBusHandlers.get(event) ?? []) {
					handler(payload);
				}
			},
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
}

function createUiHarness() {
	const statusUpdates = [];
	const widgetUpdates = [];
	const notifications = [];
	return {
		statusUpdates,
		widgetUpdates,
		notifications,
		ui: {
			setStatus(key, text) {
				statusUpdates.push({ key, text });
			},
			setWidget(key, content, options) {
				widgetUpdates.push({ key, content, options });
			},
			notify(message, type = "info") {
				notifications.push({ message, type });
			},
		},
	};
}

function createCtx(cwd, ui) {
	return {
		hasUI: true,
		cwd,
		ui,
	};
}

async function fireAll(pi, event, payload, ctx) {
	for (const handler of pi.handlers.get(event) ?? []) {
		await handler(payload, ctx);
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function installFakeTk(agentDir, statePath) {
	const binDir = join(agentDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const tkPath = join(binDir, "tk");
	writeFileSync(
		tkPath,
		`#!/usr/bin/env bash
set -euo pipefail
state="$(cat ${JSON.stringify(statePath)})"
case "\${1:-}" in
  help|--help|-h)
    echo "tk - test ticket system"
    echo "Usage: tk <command> [args]"
    echo "Tickets stored as markdown files in .tickets/"
    ;;
  query)
    if [[ ! -d .tickets ]]; then
      echo "no .tickets directory found" >&2
      exit 1
    fi
    case "$state" in
      default|ansi)
        cat <<'EOF'
{"id":"tlhf-16ll","status":"open"}
{"id":"tlhf-7rd2","status":"open"}
{"id":"tlhf-xeww","status":"closed"}
EOF
        ;;
      updated)
        cat <<'EOF'
{"id":"tlhf-16ll","status":"open"}
{"id":"tlhf-7rd2","status":"closed"}
{"id":"tlhf-xeww","status":"closed"}
EOF
        ;;
      empty)
        ;;
    esac
    ;;
  ready)
    if [[ ! -d .tickets ]]; then
      echo "no .tickets directory found" >&2
      exit 1
    fi
    case "$state" in
      default)
        echo "tlhf-7rd2 [P2][open] - ${READY_TICKET_TITLE}"
        ;;
      ansi)
        printf 'tlhf-7rd2 [P2][open] - Implement \\033[31mread-only\\033[0m ticket workflow\\a status UI\\n'
        ;;
      updated|empty)
        ;;
    esac
    ;;
  blocked)
    if [[ ! -d .tickets ]]; then
      echo "no .tickets directory found" >&2
      exit 1
    fi
    case "$state" in
      default|updated|ansi)
        echo "tlhf-16ll [P2][open] - Document and validate ticket workflow UI experiment <- [tlhf-7rd2]"
        ;;
      empty)
        ;;
    esac
    ;;
  *)
    exit 0
    ;;
esac
`,
	);
	chmodSync(tkPath, 0o755);
}

test("ticket workflow UI stays completely disabled by default", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);

		assert.equal(pi.commands.has("tk-status"), false);
		assert.deepEqual(uiHarness.statusUpdates, [{ key: "tlh-ticket-workflow", text: undefined }]);
		assert.deepEqual(uiHarness.widgetUpdates, [{ key: "tlh-ticket-workflow", content: undefined, options: undefined }]);
	});
});

test("enabled ticket workflow UI publishes footer status, ignores unrelated bash results, refreshes after tk bash and user_bash results, and exposes /tk-status", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "default\n");
	installFakeTk(fixture.agent, statePath);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [TICKET_WORKFLOW_UI_FEATURE] } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);

		assert.equal(pi.commands.has("tk-status"), true);
		assert.equal(
			uiHarness.statusUpdates.at(-1)?.text,
			READY_TICKET_FOOTER_STATUS,
		);
		assert.equal(uiHarness.widgetUpdates.at(-1)?.content, undefined);

		writeFileSync(statePath, "updated\n");
		await fireAll(pi, "tool_result", { toolName: "bash", input: { command: "git status" } }, ctx);
		assert.equal(
			uiHarness.statusUpdates.at(-1)?.text,
			READY_TICKET_FOOTER_STATUS,
		);

		await fireAll(pi, "tool_result", { toolName: "bash", input: { command: "tk close tlhf-7rd2" } }, ctx);
		assert.equal(uiHarness.statusUpdates.at(-1)?.text, undefined);
		assert.equal(uiHarness.widgetUpdates.at(-1)?.content, undefined);

		writeFileSync(statePath, "default\n");
		const [userBashHandler] = pi.handlers.get("user_bash") ?? [];
		const userBashResult = userBashHandler({ command: "tk ready", cwd: fixture.cwd }, ctx);
		assert.equal(userBashResult, undefined);
		await delay(300);
		assert.equal(
			uiHarness.statusUpdates.at(-1)?.text,
			READY_TICKET_FOOTER_STATUS,
		);

		writeFileSync(statePath, "updated\n");
		await pi.commands.get("tk-status").handler("", ctx);
		assert.equal(uiHarness.notifications.at(-1)?.type, "info");
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /tk: 0 ready • 1 blocked • 1 active • 3 total/);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /Blocked:/);
		assert.doesNotMatch(uiHarness.notifications.at(-1)?.message ?? "", /start|close .*tlhf-/i);
	});
});

test("ticket workflow UI strips ANSI and control sequences from the ready ticket footer title", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "ansi\n");
	installFakeTk(fixture.agent, statePath);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [TICKET_WORKFLOW_UI_FEATURE] } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);

		assert.equal(
			uiHarness.statusUpdates.at(-1)?.text,
			"working on tk: Implement read-only ticket workflow status UI\nUse /tk-status for details.",
		);
		assert.doesNotMatch(uiHarness.statusUpdates.at(-1)?.text ?? "", /\u001b|\u0007/);
	});
});

test("ticket workflow UI reacts to current-session experimental enable and disable", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "default\n");
	installFakeTk(fixture.agent, statePath);
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [] } } }, null, 2)}\n`);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		assert.equal(pi.commands.has("tk-status"), false);
		assert.equal(uiHarness.statusUpdates.at(-1)?.text, undefined);

		writeFileSync(settingsPath, `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [TICKET_WORKFLOW_UI_FEATURE] } } }, null, 2)}\n`);
		pi.events.emit("tlh:experimental-feature-changed", {
			cwd: fixture.cwd,
			enabled: true,
			featureId: TICKET_WORKFLOW_UI_FEATURE,
		});

		assert.equal(pi.commands.has("tk-status"), true);
		assert.equal(
			uiHarness.statusUpdates.at(-1)?.text,
			READY_TICKET_FOOTER_STATUS,
		);
		assert.equal(uiHarness.widgetUpdates.at(-1)?.content, undefined);

		writeFileSync(settingsPath, `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [] } } }, null, 2)}\n`);
		pi.events.emit("tlh:experimental-feature-changed", {
			cwd: fixture.cwd,
			enabled: false,
			featureId: TICKET_WORKFLOW_UI_FEATURE,
		});

		assert.equal(uiHarness.statusUpdates.at(-1)?.text, undefined);
		assert.equal(uiHarness.widgetUpdates.at(-1)?.content, undefined);
		await pi.commands.get("tk-status").handler("", ctx);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /Ticket workflow UI is disabled/i);
	});
});

test("enabled ticket workflow UI stays quiet without a .tickets repo while /tk-status reports no-repo", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "default\n");
	installFakeTk(fixture.agent, statePath);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [TICKET_WORKFLOW_UI_FEATURE] } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		assert.equal(pi.commands.has("tk-status"), true);
		assert.deepEqual(uiHarness.statusUpdates, [{ key: "tlh-ticket-workflow", text: undefined }]);
		assert.deepEqual(uiHarness.widgetUpdates, [{ key: "tlh-ticket-workflow", content: undefined, options: undefined }]);

		await pi.commands.get("tk-status").handler("", ctx);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /No \.tickets directory found/i);
	});
});

test("enabled ticket workflow UI stays quiet for an empty ticket repo while /tk-status reports no tickets", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "empty\n");
	installFakeTk(fixture.agent, statePath);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [TICKET_WORKFLOW_UI_FEATURE] } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		assert.equal(pi.commands.has("tk-status"), true);
		assert.deepEqual(uiHarness.statusUpdates, [{ key: "tlh-ticket-workflow", text: undefined }]);
		assert.deepEqual(uiHarness.widgetUpdates, [{ key: "tlh-ticket-workflow", content: undefined, options: undefined }]);

		await pi.commands.get("tk-status").handler("", ctx);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /tk: no tickets in this repo/i);
	});
});

test("enabled ticket workflow UI stays quiet when .tickets exists and tk is missing while /tk-status reports unavailable", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { experimental: { enabledFeatures: [TICKET_WORKFLOW_UI_FEATURE] } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, PATH: "" }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		assert.equal(pi.commands.has("tk-status"), true);
		assert.deepEqual(uiHarness.statusUpdates, [{ key: "tlh-ticket-workflow", text: undefined }]);
		assert.deepEqual(uiHarness.widgetUpdates, [{ key: "tlh-ticket-workflow", content: undefined, options: undefined }]);

		await pi.commands.get("tk-status").handler("", ctx);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /Ticket workflow status unavailable: tk is unavailable/i);
	});
});
