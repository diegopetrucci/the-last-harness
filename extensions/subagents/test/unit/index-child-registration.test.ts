import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentToolEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[SUBAGENT_CHILD_ENV];
  return env;
}

describe("subagent extension child mode", () => {
  it("does not mutate Pi tool expansion before direct subagent tool execution", () => {
    const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			const calls = [];
			const ctx = {
				cwd: process.cwd(),
				hasUI: true,
				ui: {
					setToolsExpanded(value) { calls.push(value); },
					setWidget() {},
					requestRender() {},
					theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } },
				},
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			await registeredTool.execute("collapse-check", { action: "list" }, new AbortController().signal, undefined, ctx);
			if (calls.length !== 0) throw new Error("unexpected Pi tool expansion mutation: " + JSON.stringify(calls));
		`;

    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./test/support/register-loader.mjs",
        "--input-type=module",
        "--eval",
        script,
      ],
      { cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
    );
  });

  it("consumes enhanced Ctrl+Shift+D before Pi debug and keeps the registered shortcut discoverable", () => {
    const script = String.raw`
			import assert from "node:assert/strict";
			import registerSubagentExtension from "./src/extension/index.ts";
			import { SUBAGENT_LIVE_DETAIL_SHORTCUT } from "./src/shared/subagent-shortcuts.ts";

			const events = { on() { return () => {}; }, emit() {} };
			const extensionHandlers = new Map();
			const shortcuts = new Map();
			let registeredTool;
			const fakePi = new Proxy({
				events,
				on(type, handler) {
					const handlers = extensionHandlers.get(type) ?? [];
					handlers.push(handler);
					extensionHandlers.set(type, handlers);
				},
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {},
				registerShortcut(key, definition) { shortcuts.set(key, definition); },
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			assert.ok(registeredTool, "subagent tool was not registered");
			assert.equal(SUBAGENT_LIVE_DETAIL_SHORTCUT, "ctrl+shift+d");
			const shortcut = shortcuts.get(SUBAGENT_LIVE_DETAIL_SHORTCUT);
			assert.ok(shortcut, "Ctrl+Shift+D shortcut was not registered");

			let renderRequests = 0;
			let piExpansionChanges = 0;
			const terminalInputHandlers = new Map();
			const terminalInputUnsubscribeCalls = new Map();
			const makeContext = (sessionId) => ({
				cwd: process.cwd(),
				hasUI: true,
				ui: {
					setWidget() {},
					onTerminalInput(handler) {
						terminalInputHandlers.set(sessionId, handler);
						let active = true;
						return () => {
							if (!active) return;
							active = false;
							terminalInputUnsubscribeCalls.set(sessionId, (terminalInputUnsubscribeCalls.get(sessionId) ?? 0) + 1);
							if (terminalInputHandlers.get(sessionId) === handler) terminalInputHandlers.delete(sessionId);
						};
					},
					requestRender() { renderRequests++; },
					setToolsExpanded() { piExpansionChanges++; },
					theme: {
						fg(_name, text) { return text; },
						bg(_name, text) { return text; },
						bold(text) { return text; },
					},
				},
				sessionManager: {
					getSessionId() { return sessionId; },
					getSessionFile() { return null; },
					getEntries() { return []; },
				},
				modelRegistry: { getAvailable() { return []; } },
			});
			const emitExtensionEvent = async (type, event, ctx) => {
				for (const handler of extensionHandlers.get(type) ?? []) await handler(event, ctx);
			};
			const ctx = makeContext("live-detail-session");
			await emitExtensionEvent("session_start", { type: "session_start", reason: "startup" }, ctx);
			const terminalInput = terminalInputHandlers.get("live-detail-session");
			assert.equal(typeof terminalInput, "function", "session_start did not install the raw input listener");

			const renderRequestsBeforeIgnoredInput = renderRequests;
			assert.equal(terminalInput("\x04"), undefined, "raw Ctrl+D was consumed as Ctrl+Shift+D");
			assert.equal(terminalInput("x"), undefined, "unrelated input was consumed");
			assert.equal(renderRequests, renderRequestsBeforeIgnoredInput, "ignored input requested a render");

			const enhancedCtrlShiftDPress = "\x1b[100;6u";
			const enhancedCtrlShiftDRelease = "\x1b[100;6:3u";
			assert.deepEqual(terminalInput(enhancedCtrlShiftDPress), { consume: true });
			assert.deepEqual(terminalInput(enhancedCtrlShiftDRelease), { consume: true });
			assert.equal(renderRequests, renderRequestsBeforeIgnoredInput, "Pi 0.83 widget updates must not call requestRender directly");
			shortcut.handler(ctx);
			assert.equal(piExpansionChanges, 0, "shortcut mutated Pi tool expansion");
			assert.equal(renderRequests, 0, "Pi 0.83 widget updates must not call requestRender directly");
			const replacementCtx = makeContext("replacement-session");
			await emitExtensionEvent("session_start", { type: "session_start", reason: "resume" }, replacementCtx);
			assert.equal(terminalInputUnsubscribeCalls.get("live-detail-session"), 1, "session reset did not unsubscribe the old raw listener once");
			assert.equal(terminalInputHandlers.has("live-detail-session"), false, "session reset retained the old raw listener");
			assert.equal(typeof terminalInputHandlers.get("replacement-session"), "function", "session reset did not reinstall the raw listener");
			shortcut.handler(replacementCtx);
			await emitExtensionEvent("session_shutdown", { type: "session_shutdown", reason: "quit" }, replacementCtx);
			assert.equal(terminalInputUnsubscribeCalls.get("replacement-session"), 1, "shutdown did not unsubscribe the replacement raw listener once");
			assert.equal(terminalInputHandlers.has("replacement-session"), false, "shutdown retained the replacement raw listener");
		`;

    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./test/support/register-loader.mjs",
        "--input-type=module",
        "--eval",
        script,
      ],
      { cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
    );
  });

  it("renders deprecated async:true launches like any other launch", () => {
    const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			const theme = { fg(_name, text) { return text; }, bold(text) { return text; } };
			const asyncSingle = registeredTool.renderCall({ agent: "worker", async: true }, theme).text;
			const asyncParallel = registeredTool.renderCall({ tasks: [{ agent: "worker" }, { agent: "reviewer" }], async: true }, theme).text;
			if (asyncSingle.includes("[async]") || !asyncSingle.includes("worker")) throw new Error("unexpected async single call label: " + asyncSingle);
			if (asyncParallel.includes("[async]") || asyncParallel.includes("parallel")) throw new Error("unexpected async parallel call label: " + asyncParallel);
		`;

    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./test/support/register-loader.mjs",
        "--input-type=module",
        "--eval",
        script,
      ],
      { cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
    );
  });

  it("returns before registering anything for child subagents", () => {
    const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			import { SUBAGENT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			const calls = [];
			const fakePi = new Proxy({}, {
				get(_target, prop) {
					return (..._args) => {
						calls.push(String(prop));
						return undefined;
					};
				},
			});
			registerSubagentExtension(fakePi);
			if (calls.length > 0) {
				throw new Error("Unexpected child-mode registrations: " + calls.join(", "));
			}
		`;

    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./test/support/register-loader.mjs",
        "--input-type=module",
        "--eval",
        script,
      ],
      { cwd: projectRoot, stdio: "pipe" },
    );
  });
});
