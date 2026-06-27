/**
 * End-to-end invocation tests for lazily-loaded TLH commands.
 *
 * Each test verifies that the deferred dynamic import actually resolves and
 * that the exported handler function is callable. A broken import path or a
 * missing export would cause the dynamic import to throw, failing in CI rather
 * than silently at command-time.
 *
 * Also includes a load-time probe asserting that the lazified modules are NOT
 * statically imported by the extension entry (guards against accidental
 * reversion to static imports).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMinimalPi() {
	const commands = new Map();
	const eventListeners = new Map();
	return {
		commands,
		eventListeners,
		registerCommand(name, options) {
			commands.set(name, options);
		},
		on(event, handler) {
			if (!eventListeners.has(event)) {
				eventListeners.set(event, []);
			}
			eventListeners.get(event).push(handler);
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		sendUserMessage: () => undefined,
		getAllTools: () => [],
	};
}

function createMinimalCtx({ hasUI = false } = {}) {
	const notifications = [];
	return {
		notifications,
		ctx: {
			hasUI,
			cwd: "/tmp",
			ui: {
				notify(message, type) {
					notifications.push({ message, type });
				},
				getEditorText: () => "",
				pasteToEditor: () => undefined,
			},
			model: undefined,
			sessionManager: {
				getBranch: () => [],
				getEntries: () => [],
				getHeader: () => ({ id: "s1", timestamp: "2026-01-01T00:00:00Z" }),
				getLeafId: () => "leaf-1",
				getSessionName: () => "test session",
				getSessionFile: () => null,
				getSessionDir: () => null,
				getCwd: () => "/tmp",
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Load-time probe: lazified modules must NOT appear as static imports
// ---------------------------------------------------------------------------

test("review.ts, tokens.ts, and annotate-last-message.ts are not statically imported by the extension entry", () => {
	const extensionSource = readFileSync(
		fileURLToPath(new URL("../extensions/the-last-harness.ts", import.meta.url)),
		"utf8",
	);

	// Static import lines must be absent for the lazified modules
	assert.doesNotMatch(
		extensionSource,
		/^import\s+.*from\s+"\.\/the-last-harness\/review\.js"/m,
		"review.ts must not be statically imported at startup",
	);
	assert.doesNotMatch(
		extensionSource,
		/^import\s+.*from\s+"\.\/the-last-harness\/tokens\.js"/m,
		"tokens.ts must not be statically imported at startup",
	);
	assert.doesNotMatch(
		extensionSource,
		/^import\s+.*from\s+"\.\/the-last-harness\/annotate-last-message\.js"/m,
		"annotate-last-message.ts must not be statically imported at startup",
	);

	// Dynamic import expressions must be present
	assert.match(
		extensionSource,
		/import\("\.\/the-last-harness\/review\.js"\)/,
		"review.ts must be lazily imported via dynamic import()",
	);
	assert.match(
		extensionSource,
		/import\("\.\/the-last-harness\/tokens\.js"\)/,
		"tokens.ts must be lazily imported via dynamic import()",
	);
	assert.match(
		extensionSource,
		/import\("\.\/the-last-harness\/annotate-last-message\.js"\)/,
		"annotate-last-message.ts must be lazily imported via dynamic import()",
	);
});

// ---------------------------------------------------------------------------
// /review — reviewCommandHandler import and early-exit invocation
// ---------------------------------------------------------------------------

test("reviewCommandHandler is exported from review.ts and callable", async () => {
	const { reviewCommandHandler } = await jiti.import("../extensions/the-last-harness/review.ts");
	assert.equal(typeof reviewCommandHandler, "function", "reviewCommandHandler must be a function");

	// Drive the hasUI=false early-exit path so we don't need real git or TUI.
	// The handler checks the primary agent selection first; set up the env to
	// make currentReviewPrimaryAgentSelection return a non-architect selection
	// by pointing PI_CODING_AGENT_DIR at a directory with no settings.
	const { notifications, ctx } = createMinimalCtx({ hasUI: false });

	const pi = createMinimalPi();

	// Call the handler. The primary-agent check reads settings from disk; since
	// our temp agent dir has no settings the selection defaults to "rush", which
	// will trigger the "blocked" error path (non-architect primary).
	await reviewCommandHandler(pi, "", ctx);

	// We expect a notification — either the primary-blocked error or the TUI-required error.
	assert.ok(notifications.length > 0, "reviewCommandHandler must produce at least one notification");
	const types = notifications.map((n) => n.type);
	assert.ok(
		types.every((t) => t === "error" || t === "warning" || t === "info"),
		"all notifications should have a known type",
	);
});

// ---------------------------------------------------------------------------
// /tokens — tokensCommandHandler import and argument-rejection invocation
// ---------------------------------------------------------------------------

test("tokensCommandHandler is exported from tokens.ts and callable", async () => {
	const { tokensCommandHandler } = await jiti.import("../extensions/the-last-harness/tokens.ts");
	assert.equal(typeof tokensCommandHandler, "function", "tokensCommandHandler must be a function");

	const pi = createMinimalPi();
	const { notifications, ctx } = createMinimalCtx();

	// Pass non-empty args — the handler immediately rejects with "Usage: /tokens".
	await tokensCommandHandler(pi, "some-extra-args", ctx);

	assert.equal(notifications.length, 1, "should emit exactly one notification for invalid args");
	assert.equal(notifications[0].type, "error");
	assert.match(notifications[0].message, /Usage: \/tokens/);
});

// ---------------------------------------------------------------------------
// /tokens — tokensCommandHandler produces an error notification on empty session
// ---------------------------------------------------------------------------

test("tokensCommandHandler runs handler body (empty-session path) without throwing", async () => {
	const { tokensCommandHandler } = await jiti.import("../extensions/the-last-harness/tokens.ts");

	const pi = createMinimalPi();
	const { notifications, ctx } = createMinimalCtx();

	// Provide a no-op openReport to avoid actually opening a browser; inject
	// a custom now() to make the report reproducible.
	let opened = false;
	await tokensCommandHandler(pi, "", ctx, {
		openReport: async () => {
			opened = true;
		},
		now: () => new Date("2026-01-01T00:00:00Z"),
	});

	// Either the report was opened (success path) or we got an error notification.
	// Both outcomes confirm the handler body ran without the import throwing.
	const hasResult = opened || notifications.some((n) => n.type === "error");
	assert.ok(hasResult, "tokensCommandHandler must either open a report or emit an error notification");
});

// ---------------------------------------------------------------------------
// /annotate-last-message — buildAnnotateLastMessageCommandHandler import and invocation
// ---------------------------------------------------------------------------

test("buildAnnotateLastMessageCommandHandler is exported from annotate-last-message.ts and callable", async () => {
	const { buildAnnotateLastMessageCommandHandler } = await jiti.import(
		"../extensions/the-last-harness/annotate-last-message.ts",
	);
	assert.equal(
		typeof buildAnnotateLastMessageCommandHandler,
		"function",
		"buildAnnotateLastMessageCommandHandler must be a function",
	);

	const pi = createMinimalPi();
	const handler = buildAnnotateLastMessageCommandHandler(pi);
	assert.equal(typeof handler, "function", "buildAnnotateLastMessageCommandHandler must return a handler function");

	// Register the session_shutdown listener — verify pi.on was called
	const shutdownListeners = pi.eventListeners.get("session_shutdown") ?? [];
	assert.ok(shutdownListeners.length > 0, "session_shutdown listener must be registered during setup");

	// Invoke with hasUI=false: the handler notifies "requires interactive mode" and returns.
	const { notifications, ctx } = createMinimalCtx({ hasUI: false });
	await handler("", ctx);

	assert.equal(notifications.length, 1, "should emit exactly one notification for non-UI context");
	assert.equal(notifications[0].type, "error");
	assert.match(notifications[0].message, /requires interactive mode/i);
});

test("buildAnnotateLastMessageCommandHandler invoked twice reuses closure state (no duplicate event listener)", async () => {
	const { buildAnnotateLastMessageCommandHandler } = await jiti.import(
		"../extensions/the-last-harness/annotate-last-message.ts",
	);

	const pi = createMinimalPi();
	// Call buildAnnotateLastMessageCommandHandler once (as the entry file does).
	const handler = buildAnnotateLastMessageCommandHandler(pi);

	const shutdownListeners = pi.eventListeners.get("session_shutdown") ?? [];
	assert.equal(shutdownListeners.length, 1, "exactly one session_shutdown listener per setup call");

	// Invoking the returned handler multiple times must not register more listeners.
	const { ctx: ctx1 } = createMinimalCtx({ hasUI: false });
	const { ctx: ctx2 } = createMinimalCtx({ hasUI: false });
	await handler("", ctx1);
	await handler("", ctx2);

	const shutdownListenersAfter = pi.eventListeners.get("session_shutdown") ?? [];
	assert.equal(
		shutdownListenersAfter.length,
		1,
		"session_shutdown listener count must stay at 1 after repeated handler invocations",
	);
});

// ---------------------------------------------------------------------------
// registerAnnotateLastMessageCommand — backward-compat API still works
// ---------------------------------------------------------------------------

test("registerAnnotateLastMessageCommand (legacy API) still registers the command correctly", async () => {
	const { registerAnnotateLastMessageCommand } = await jiti.import(
		"../extensions/the-last-harness/annotate-last-message.ts",
	);
	assert.equal(typeof registerAnnotateLastMessageCommand, "function");

	const pi = createMinimalPi();
	registerAnnotateLastMessageCommand(pi);

	assert.ok(pi.commands.has("annotate-last-message"), "command must be registered");
	assert.equal(typeof pi.commands.get("annotate-last-message").handler, "function");
});

// ---------------------------------------------------------------------------
// registerReviewCommand — backward-compat API still works
// ---------------------------------------------------------------------------

test("registerReviewCommand (legacy API) still registers the command correctly", async () => {
	const { registerReviewCommand } = await jiti.import("../extensions/the-last-harness/review.ts");
	assert.equal(typeof registerReviewCommand, "function");

	const pi = createMinimalPi();
	registerReviewCommand(pi);

	assert.ok(pi.commands.has("review"), "review command must be registered");
	assert.equal(typeof pi.commands.get("review").handler, "function");
	// getArgumentCompletions is present and returns null (picker-only, no completions)
	assert.equal(pi.commands.get("review").getArgumentCompletions?.(""), null);
});

// ---------------------------------------------------------------------------
// registerTokensCommand — backward-compat API still works
// ---------------------------------------------------------------------------

test("registerTokensCommand (legacy API) still registers the command correctly", async () => {
	const { registerTokensCommand } = await jiti.import("../extensions/the-last-harness/tokens.ts");
	assert.equal(typeof registerTokensCommand, "function");

	const pi = createMinimalPi();
	let opened = false;
	registerTokensCommand(pi, {
		openReport: async () => {
			opened = true;
		},
	});

	assert.ok(pi.commands.has("tokens"), "tokens command must be registered");
	assert.equal(typeof pi.commands.get("tokens").handler, "function");

	// Verify the registered handler still rejects args (uses the same handler body)
	const { notifications, ctx } = createMinimalCtx();
	await pi.commands.get("tokens").handler("bad-args", ctx);
	assert.deepEqual(notifications, [{ message: "Usage: /tokens", type: "error" }]);
	assert.equal(opened, false);
});
