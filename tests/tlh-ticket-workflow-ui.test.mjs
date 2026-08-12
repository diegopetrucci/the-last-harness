import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { createTlhTicketWorkflowUiRuntime, registerTlhTicketWorkflowUi } = await jiti.import(
	"../extensions/the-last-harness/ticket-workflow-ui.ts",
);

function resetTicketWorkflowTestState() {
	delete process.env.TICKETS_DIR;
}

test.beforeEach(resetTicketWorkflowTestState);
test.afterEach(resetTicketWorkflowTestState);

const IN_PROGRESS_TICKET_TITLE = "Implement scoped ticket footer selection";

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
    tickets_dir="\${TICKETS_DIR:-.tickets}"
    if [[ ! -d "$tickets_dir" ]]; then
      echo "Error: tickets directory '$tickets_dir' does not exist" >&2
      exit 1
    fi
    case "$state" in
      default|ansi|blocked-in-progress)
        cat <<'EOF'
{"id":"tlhf-16ll","status":"open"}
{"id":"tlhf-7rd2","status":"in_progress"}
{"id":"tlhf-xeww","status":"closed"}
EOF
        ;;
      multiple-in-progress)
        cat <<'EOF'
{"id":"tlhf-16ll","status":"in_progress"}
{"id":"tlhf-7rd2","status":"in_progress"}
{"id":"tlhf-xeww","status":"open"}
EOF
        ;;
      show-fails)
        cat <<'EOF'
{"id":"tlhf-16ll","status":"open"}
{"id":"tlhf-7rd2","status":"in_progress"}
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
    tickets_dir="\${TICKETS_DIR:-.tickets}"
    if [[ ! -d "$tickets_dir" ]]; then
      echo "Error: tickets directory '$tickets_dir' does not exist" >&2
      exit 1
    fi
    case "$state" in
      default|ansi|updated|blocked-in-progress|show-fails)
        echo "tlhf-16ll [P1][open] - Higher priority open ticket"
        ;;
      multiple-in-progress)
        echo "tlhf-xeww [P2][open] - Open ticket that should not own the footer"
        ;;
      empty)
        ;;
    esac
    ;;
  blocked)
    tickets_dir="\${TICKETS_DIR:-.tickets}"
    if [[ ! -d "$tickets_dir" ]]; then
      echo "Error: tickets directory '$tickets_dir' does not exist" >&2
      exit 1
    fi
    case "$state" in
      default|updated|ansi|show-fails)
        echo "tlhf-16ll [P1][open] - Higher priority open ticket <- [tlhf-7rd2]"
        ;;
      blocked-in-progress)
        echo "tlhf-7rd2 [P2][in_progress] - ${IN_PROGRESS_TICKET_TITLE} <- [tlhf-16ll]"
        ;;
      multiple-in-progress)
        echo "tlhf-16ll [P2][in_progress] - First in-progress ticket <- [tlhf-xeww]"
        ;;
      empty)
        ;;
    esac
    ;;
  show)
    tickets_dir="\${TICKETS_DIR:-.tickets}"
    if [[ ! -d "$tickets_dir" ]]; then
      echo "Error: tickets directory '$tickets_dir' does not exist" >&2
      exit 1
    fi
    case "$state:$2" in
      default:tlhf-7rd2|updated:tlhf-7rd2|blocked-in-progress:tlhf-7rd2)
        cat <<'EOF'
---
id: tlhf-7rd2
status: in_progress
---
# ${IN_PROGRESS_TICKET_TITLE}
EOF
        ;;
      ansi:tlhf-7rd2)
        printf '%s\n' '---' 'id: tlhf-7rd2' 'status: in_progress' '---'
        printf '%b\n' '# Implement scoped\\033[31m ticket\\033[0m footer\\a selection'
        ;;
      show-fails:tlhf-7rd2)
        echo "ticket metadata unavailable" >&2
        exit 1
        ;;
      multiple-in-progress:tlhf-16ll)
        cat <<'EOF'
---
id: tlhf-16ll
status: in_progress
---
# First in-progress ticket
EOF
        ;;
      multiple-in-progress:tlhf-7rd2)
        cat <<'EOF'
---
id: tlhf-7rd2
status: in_progress
---
# Second in-progress ticket
EOF
        ;;
      *)
        echo "ticket not found" >&2
        exit 1
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

function installScopeAwareFakeTk(agentDir, repoATicketsDir, repoBTicketsDir) {
	const binDir = join(agentDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const tkPath = join(binDir, "tk");
	writeFileSync(
		tkPath,
		`#!/usr/bin/env bash
set -euo pipefail
repo_a=${JSON.stringify(repoATicketsDir)}
repo_b=${JSON.stringify(repoBTicketsDir)}
tickets_dir="\${TICKETS_DIR:-.tickets}"
if [[ ! -d "$tickets_dir" ]]; then
  echo "Error: tickets directory '$tickets_dir' does not exist" >&2
  exit 1
fi
case "$tickets_dir" in
  "$repo_a")
    ticket_id="repo-a-ticket"
    ticket_title="Repo A ticket title"
    ;;
  "$repo_b")
    ticket_id="repo-b-ticket"
    ticket_title="Repo B ticket title"
    ;;
  *)
    echo "unexpected tickets dir: $tickets_dir" >&2
    exit 1
    ;;
esac
case "\${1:-}" in
  help|--help|-h)
    echo "tk - test ticket system"
    echo "Usage: tk <command> [args]"
    echo "Tickets stored as markdown files in .tickets/"
    ;;
  query)
    printf '{"id":"%s","status":"in_progress"}\n' "$ticket_id"
    ;;
  ready|blocked)
    ;;
  show)
    printf '%s\n' '---' "id: $ticket_id" 'status: in_progress' '---' "# $ticket_title"
    ;;
  *)
    exit 0
    ;;
esac
`,
	);
	chmodSync(tkPath, 0o755);
}

test("ticket workflow UI loads by default and registers /tickets without setting footer status", async (t) => {
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

		assert.equal(pi.commands.has("tickets"), true);
		// Footer status is never set — ticket workflow no longer renders in the primary footer.
		assert.deepEqual(uiHarness.statusUpdates, []);
		assert.deepEqual(uiHarness.widgetUpdates, []);
	});
});

test("ticket workflow UI correctly rescopes TICKETS_DIR for each new session and reports per-repo details via /tickets", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { test: t });
	const repoA = join(fixture.dir, "repo-a");
	const repoB = join(fixture.dir, "repo-b");
	const repoATicketsDir = join(repoA, ".tickets");
	const repoBTicketsDir = join(repoB, ".tickets");
	mkdirSync(repoATicketsDir, { recursive: true });
	mkdirSync(repoBTicketsDir, { recursive: true });
	installScopeAwareFakeTk(fixture.agent, repoATicketsDir, repoBTicketsDir);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TICKETS_DIR: undefined }, async () => {
		const uiHarness = createUiHarness();
		const ctxA = createCtx(repoA, uiHarness.ui);
		const ctxB = createCtx(repoB, uiHarness.ui);

		// Session A starts — TICKETS_DIR scoped to repo A.
		const piA = createPiHarness();
		registerTlhTicketWorkflowUi(piA);
		await fireAll(piA, "session_start", { reason: "restore" }, ctxA);
		assert.equal(process.env.TICKETS_DIR, repoATicketsDir);
		assert.deepEqual(uiHarness.statusUpdates, []);

		// /tickets in session A shows repo A details.
		await piA.commands.get("tickets").handler("", ctxA);
		assert.equal(process.env.TICKETS_DIR, repoATicketsDir);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /In progress: repo-a-ticket - Repo A ticket title/);

		await fireAll(piA, "session_shutdown", {}, ctxA);

		// Session B starts — TICKETS_DIR rescopes to repo B.
		const piB = createPiHarness();
		registerTlhTicketWorkflowUi(piB);
		await fireAll(piB, "session_start", { reason: "restore" }, ctxB);
		assert.equal(process.env.TICKETS_DIR, repoBTicketsDir);
		assert.deepEqual(uiHarness.statusUpdates, []);

		// /tickets in session B shows repo B details.
		await piB.commands.get("tickets").handler("", ctxB);
		assert.equal(process.env.TICKETS_DIR, repoBTicketsDir);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /In progress: repo-b-ticket - Repo B ticket title/);

		await fireAll(piB, "session_shutdown", {}, ctxB);

		// Session A restored — TICKETS_DIR rescopes back to repo A.
		const piARestored = createPiHarness();
		registerTlhTicketWorkflowUi(piARestored);
		await fireAll(piARestored, "session_start", { reason: "restore" }, ctxA);
		assert.equal(process.env.TICKETS_DIR, repoATicketsDir);

		await piARestored.commands.get("tickets").handler("", ctxA);
		assert.equal(process.env.TICKETS_DIR, repoATicketsDir);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /In progress: repo-a-ticket - Repo A ticket title/);
	});
});

test("ticket workflow UI never sets footer status; /tickets still exposes read-only ticket details", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "default\n");
	installFakeTk(fixture.agent, statePath);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);

		assert.equal(pi.commands.has("tickets"), true);
		// Footer status never set — ticket workflow removed from primary footer.
		assert.deepEqual(uiHarness.statusUpdates, []);
		assert.deepEqual(uiHarness.widgetUpdates, []);
		assert.equal(pi.handlers.has("user_bash"), false);
		assert.equal(pi.handlers.has("tool_result"), false);
		assert.equal(pi.handlers.has("session_shutdown"), false);

		// /tickets on-demand command still reports correct details.
		await pi.commands.get("tickets").handler("", ctx);
		assert.equal(uiHarness.notifications.at(-1)?.type, "info");
		assert.match(
			uiHarness.notifications.at(-1)?.message ?? "",
			/tk: 1 ready • 1 blocked • 1 in progress • 2 active • 3 total/,
		);
		assert.match(
			uiHarness.notifications.at(-1)?.message ?? "",
			/In progress: tlhf-7rd2 - Implement scoped ticket footer selection/,
		);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /Ready:/);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /Blocked:/);
		assert.doesNotMatch(uiHarness.notifications.at(-1)?.message ?? "", /start|close .*tlhf-/i);
	});
});

test("ticket workflow UI /tickets falls back to ticket id when the sole in-progress ticket title is unavailable", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "show-fails\n");
	installFakeTk(fixture.agent, statePath);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		// No footer status set.
		assert.deepEqual(uiHarness.statusUpdates, []);

		await pi.commands.get("tickets").handler("", ctx);
		assert.match(
			uiHarness.notifications.at(-1)?.message ?? "",
			/tk: 1 ready • 1 blocked • 1 in progress • 2 active • 3 total/,
		);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /In progress: tlhf-7rd2/);
		assert.doesNotMatch(uiHarness.notifications.at(-1)?.message ?? "", /start|close .*tlhf-/i);
	});
});

test("ticket workflow UI /tickets sanitizes decoded terminal controls from ticket ids and titles", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "default\n");
	installFakeTk(fixture.agent, statePath);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const decodedUnsafeTicketId = "tlhf-safe\u001b[31m-red\u001b[0m\u0007";
		let showCalls = 0;
		const runner = (_command, _cwd, args) => {
			switch (args[0]) {
				case "query":
					return {
						status: 0,
						stdout: `${JSON.stringify({ id: decodedUnsafeTicketId, status: "in_progress" })}\n`,
						stderr: "",
					};
				case "ready":
				case "blocked":
					return { status: 0, stdout: "", stderr: "" };
				case "show":
					showCalls += 1;
					assert.equal(args[1], decodedUnsafeTicketId);
					return { status: 1, stdout: "", stderr: "ticket metadata unavailable" };
				default:
					return assert.fail(`unexpected tk command: ${args.join(" ")}`);
			}
		};

		const pi = createPiHarness();
		const runtime = createTlhTicketWorkflowUiRuntime(pi, { runner });
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		runtime.applyCurrentSettings(ctx);
		// No footer status — no setStatus calls.
		assert.deepEqual(uiHarness.statusUpdates, []);

		await pi.commands.get("tickets").handler("", ctx);
		assert.equal(showCalls, 1);
		const msg = uiHarness.notifications.at(-1)?.message ?? "";
		assert.equal(msg, "tk: 0 ready • 0 blocked • 1 in progress • 1 active • 1 total\nIn progress: tlhf-safe-red");
		// Verify the /tickets output contains no raw control sequences.
		for (const character of msg) {
			const code = character.charCodeAt(0);
			assert.equal((code >= 0x00 && code <= 0x1f && code !== 0x0a) || (code >= 0x7f && code <= 0x9f), false);
		}
	});
});

test("ticket workflow UI /tickets sanitizes ANSI sequences from in-progress ticket titles", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "ansi\n");
	installFakeTk(fixture.agent, statePath);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		// No footer status set.
		assert.deepEqual(uiHarness.statusUpdates, []);

		await pi.commands.get("tickets").handler("", ctx);
		const msg = uiHarness.notifications.at(-1)?.message ?? "";
		assert.match(msg, /In progress: tlhf-7rd2 - Implement scoped ticket footer selection/);
		for (const character of msg) {
			const code = character.charCodeAt(0);
			assert.equal((code >= 0x00 && code <= 0x1f && code !== 0x0a) || (code >= 0x7f && code <= 0x9f), false);
		}
	});
});

test("ticket workflow UI /tickets reports a sole blocked in-progress ticket", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "blocked-in-progress\n");
	installFakeTk(fixture.agent, statePath);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		// No footer status set.
		assert.deepEqual(uiHarness.statusUpdates, []);

		await pi.commands.get("tickets").handler("", ctx);
		assert.match(
			uiHarness.notifications.at(-1)?.message ?? "",
			/tk: 1 ready • 1 blocked • 1 in progress • 2 active • 3 total/,
		);
		assert.match(
			uiHarness.notifications.at(-1)?.message ?? "",
			/In progress: tlhf-7rd2 - Implement scoped ticket footer selection/,
		);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /Blocked:/);
	});
});

test("ticket workflow UI /tickets lists each in-progress ticket when there are multiple", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "multiple-in-progress\n");
	installFakeTk(fixture.agent, statePath);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		// No footer status set (tickets no longer rendered in the primary footer).
		assert.deepEqual(uiHarness.statusUpdates, []);

		await pi.commands.get("tickets").handler("", ctx);
		const details = uiHarness.notifications.at(-1)?.message ?? "";
		assert.match(details, /tk: 1 ready • 1 blocked • 2 in progress • 3 active • 3 total/);
		assert.match(
			details,
			/In progress:\n- tlhf-16ll - First in-progress ticket\n- tlhf-7rd2 - Second in-progress ticket/,
		);
		assert.doesNotMatch(details, /ambiguous|Footer stays quiet/i);
	});
});

test("ticket workflow UI /tickets bounds multi-ticket title lookups to one overall timeout budget", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "default\n");
	installFakeTk(fixture.agent, statePath);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		let nowMs = 0;
		const showCalls = [];
		const runner = (_command, _cwd, args, timeoutMs) => {
			switch (args[0]) {
				case "query":
					return {
						status: 0,
						stdout: [
							'{"id":"tlhf-first","status":"in_progress"}',
							'{"id":"tlhf-slow","status":"in_progress"}',
							'{"id":"tlhf-unattempted","status":"in_progress"}',
						].join("\n"),
						stderr: "",
					};
				case "ready":
				case "blocked":
					return { status: 0, stdout: "", stderr: "" };
				case "show": {
					const ticketId = args[1];
					showCalls.push({ ticketId, timeoutMs });
					if (ticketId === "tlhf-first") {
						nowMs += 1000;
						return {
							status: 0,
							stdout: "---\nid: tlhf-first\nstatus: in_progress\n---\n# Resolved first title\n",
							stderr: "",
						};
					}
					if (ticketId === "tlhf-slow") {
						nowMs += timeoutMs;
						return {
							status: null,
							stdout: "",
							stderr: "",
							error: Object.assign(new Error("title lookup timed out"), { code: "ETIMEDOUT" }),
						};
					}
					return assert.fail(`title lookup exceeded the overall budget: ${ticketId}`);
				}
				default:
					assert.fail(`unexpected tk command: ${args.join(" ")}`);
			}
		};

		const pi = createPiHarness();
		const runtime = createTlhTicketWorkflowUiRuntime(pi, { runner, now: () => nowMs });
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		runtime.applyCurrentSettings(ctx);
		// applyCurrentSettings only registers the command; no snapshot is taken yet.
		assert.deepEqual(showCalls, []);
		assert.deepEqual(uiHarness.statusUpdates, []);

		// /tickets triggers snapshot and respects the per-budget timeout.
		await pi.commands.get("tickets").handler("", ctx);

		assert.deepEqual(showCalls, [
			{ ticketId: "tlhf-first", timeoutMs: 4000 },
			{ ticketId: "tlhf-slow", timeoutMs: 3000 },
		]);
		assert.equal(nowMs, 4000);
		const msg = uiHarness.notifications.at(-1)?.message ?? "";
		assert.match(msg, /In progress:/);
		assert.match(msg, /tlhf-first - Resolved first title/);
		assert.match(msg, /tlhf-slow/);
		assert.match(msg, /tlhf-unattempted/);
	});
});

test("legacy experimental and ticket settings do not prevent /tickets command registration", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "default\n");
	installFakeTk(fixture.agent, statePath);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { tickets: { enabled: false }, experimental: { enabledFeatures: [] } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		assert.equal(pi.commands.has("tickets"), true);
		// No footer status regardless of settings.
		assert.deepEqual(uiHarness.statusUpdates, []);

		await pi.commands.get("tickets").handler("", ctx);
		assert.match(
			uiHarness.notifications.at(-1)?.message ?? "",
			/In progress: tlhf-7rd2 - Implement scoped ticket footer selection/,
		);
	});
});

test("ticket workflow UI stays quiet without a .tickets repo while /tickets reports no-repo", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "default\n");
	installFakeTk(fixture.agent, statePath);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TICKETS_DIR: undefined }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		assert.equal(pi.commands.has("tickets"), true);
		assert.deepEqual(uiHarness.statusUpdates, []);
		assert.deepEqual(uiHarness.widgetUpdates, []);

		await pi.commands.get("tickets").handler("", ctx);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /No \.tickets directory found/i);
	});
});

test("ticket workflow UI stays quiet for an empty ticket repo while /tickets reports no tickets", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "empty\n");
	installFakeTk(fixture.agent, statePath);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		assert.equal(pi.commands.has("tickets"), true);
		assert.deepEqual(uiHarness.statusUpdates, []);
		assert.deepEqual(uiHarness.widgetUpdates, []);

		await pi.commands.get("tickets").handler("", ctx);
		assert.match(uiHarness.notifications.at(-1)?.message ?? "", /tk: no tickets in this repo/i);
	});
});

test("ticket workflow UI stays quiet when .tickets exists and tk is missing while /tickets reports unavailable", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-ui-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, PATH: "" }, async () => {
		const pi = createPiHarness();
		registerTlhTicketWorkflowUi(pi);
		const uiHarness = createUiHarness();
		const ctx = createCtx(fixture.cwd, uiHarness.ui);

		await fireAll(pi, "session_start", { reason: "restore" }, ctx);
		assert.equal(pi.commands.has("tickets"), true);
		assert.deepEqual(uiHarness.statusUpdates, []);
		assert.deepEqual(uiHarness.widgetUpdates, []);

		await pi.commands.get("tickets").handler("", ctx);
		assert.match(
			uiHarness.notifications.at(-1)?.message ?? "",
			/Ticket workflow status unavailable: tk is unavailable/i,
		);
	});
});

test("packed ticket workflow module loads with native ESM and reports via /tickets without a package-local Pi peer", (t) => {
	const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-packed-", { cwd: true, test: t });
	mkdirSync(join(fixture.cwd, ".tickets"));
	const statePath = join(fixture.dir, "tk-state");
	writeFileSync(statePath, "default\n");
	installFakeTk(fixture.agent, statePath);

	const installRoot = join(fixture.dir, "installed");
	const packageRoot = join(installRoot, "node_modules", "the-last-harness");
	const extensionRoot = join(packageRoot, "extensions", "the-last-harness");
	mkdirSync(extensionRoot, { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), '{"name":"the-last-harness","type":"module"}\n');
	for (const file of ["common.js", "tickets.js", "ticket-workflow-ui.js"]) {
		copyFileSync(new URL(`../extensions/the-last-harness/${file}`, import.meta.url), join(extensionRoot, file));
	}
	assert.equal(existsSync(join(installRoot, "node_modules", "@earendil-works")), false);

	const runnerPath = join(installRoot, "run.mjs");
	writeFileSync(
		runnerPath,
		`import { createTlhTicketWorkflowUiRuntime } from "./node_modules/the-last-harness/extensions/the-last-harness/ticket-workflow-ui.js";
const commands = new Map();
const notifications = [];
const strictApi = (value, label) => new Proxy(value, {
  get(target, key) {
    if (key in target) return target[key];
    throw new Error(\`unexpected \${label} access: \${String(key)}\`);
  },
});
const pi = strictApi({ registerCommand(name, command) { commands.set(name, command); } }, "Pi API");
const runtime = createTlhTicketWorkflowUiRuntime(pi);
runtime.applyCurrentSettings(strictApi({ hasUI: true }, "session context"));
await commands.get("tickets").handler("", strictApi({
  cwd: process.env.TEST_CWD,
  ui: { notify(message, type) { notifications.push({ message, type }); } },
}, "command context"));
console.log(JSON.stringify({ registered: commands.has("tickets"), notifications }));
`,
	);
	const env = {
		...process.env,
		HOME: fixture.home,
		PI_CODING_AGENT_DIR: fixture.agent,
		TEST_CWD: fixture.cwd,
	};
	delete env.TICKETS_DIR;
	const result = spawnSync(process.execPath, [runnerPath], { cwd: installRoot, env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const report = JSON.parse(result.stdout.trim());
	assert.equal(report.registered, true);
	assert.equal(report.notifications[0]?.type, "info");
	assert.match(
		report.notifications[0]?.message ?? "",
		/In progress: tlhf-7rd2 - Implement scoped ticket footer selection/,
	);
});
