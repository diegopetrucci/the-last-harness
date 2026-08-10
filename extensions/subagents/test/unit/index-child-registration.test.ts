import assert from "node:assert/strict";
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

			const theme = ctx.ui.theme;
			const output = ["first output line", "second output line"].join(String.fromCharCode(10));
			const result = {
				content: [{ type: "text", text: output }],
				details: {
					mode: "single",
					results: [{
						agent: "worker",
						task: "Verify live detail wiring",
						exitCode: 0,
						messages: [],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						finalOutput: output,
					}],
				},
			};
			const renderResultText = (renderedResult, context, expanded) => registeredTool.renderResult(
				renderedResult,
				{ expanded, isPartial: false },
				theme,
				context,
			).render(180).join(String.fromCharCode(10));
			const renderText = (context, expanded) => renderResultText(result, context, expanded);
			const runningResult = {
				...result,
				details: {
					...result.details,
					results: result.details.results.map((child) => ({
						...child,
						progress: { status: "running", toolCount: 0, tokens: 0, durationMs: 0, currentTool: "read" },
					})),
				},
			};

			let exportFirstProbeCalls = 0;
			const exportFirstContext = {
				state: {},
				toolCallId: "inactive-branch-export-only-row",
				invalidate() { exportFirstProbeCalls++; },
			};
			const exportFirstCollapsed = renderText(exportFirstContext, false);
			const exportFirstExpanded = renderText(exportFirstContext, true);
			assert.notEqual(exportFirstCollapsed, exportFirstExpanded, "export-first variants matched");
			assert.doesNotMatch(exportFirstCollapsed, /second output line/);
			assert.match(exportFirstExpanded, /second output line/);
			try {
				registeredTool.renderResult(runningResult, { expanded: false, isPartial: false }, theme, exportFirstContext);
				assert.equal(exportFirstContext.state.subagentResultAnimationTimer, undefined, "export-first row started an animation timer");
			} finally {
				if (exportFirstContext.state.subagentResultAnimationTimer) {
					clearInterval(exportFirstContext.state.subagentResultAnimationTimer);
					exportFirstContext.state.subagentResultAnimationTimer = undefined;
				}
			}
			assert.equal(exportFirstProbeCalls, 0, "export-first probe ran inside renderResult");
			await Promise.resolve();
			assert.equal(exportFirstProbeCalls, 1, "export-first renders did not deduplicate their deferred probe");
			shortcut.handler(ctx);
			shortcut.handler(ctx);
			assert.equal(exportFirstProbeCalls, 1, "export-first context was retained or probed repeatedly");

			let liveInvalidations = 0;
			let liveRenderFromInvalidation = "";
			let liveContext;
			liveContext = {
				state: {},
				toolCallId: "subagent-row",
				invalidate() {
					liveInvalidations++;
					liveRenderFromInvalidation = renderText(liveContext, false);
				},
			};
			const unconfirmedLiveRender = renderText(liveContext, true);
			assert.equal(liveInvalidations, 0, "initial live probe ran inside renderResult");
			assert.match(unconfirmedLiveRender, /second output line/, "unconfirmed row did not follow Pi options.expanded");
			await Promise.resolve();
			assert.equal(liveInvalidations, 1, "initial live row was not probed after renderResult");
			assert.doesNotMatch(liveRenderFromInvalidation, /second output line/, "deferred probe did not use controller state");
			assert.doesNotMatch(renderText(liveContext, true), /second output line/, "confirmed row followed Pi options.expanded");

			const htmlExportContext = {
				state: {},
				toolCallId: "subagent-row",
				invalidate() {},
			};
			const htmlCollapsed = renderText(htmlExportContext, false);
			const htmlExpanded = renderText(htmlExportContext, true);
			assert.notEqual(htmlCollapsed, htmlExpanded, "HTML collapsed and expanded output matched");
			assert.doesNotMatch(htmlCollapsed, /second output line/);
			assert.match(htmlExpanded, /second output line/);
			await Promise.resolve();

			const liveInvalidationsBeforeIgnoredInput = liveInvalidations;
			const renderRequestsBeforeIgnoredInput = renderRequests;
			assert.equal(terminalInput("\x04"), undefined, "raw Ctrl+D was consumed as Ctrl+Shift+D");
			assert.equal(terminalInput("x"), undefined, "unrelated input was consumed");
			assert.equal(liveInvalidations, liveInvalidationsBeforeIgnoredInput, "ignored input toggled live detail");
			assert.equal(renderRequests, renderRequestsBeforeIgnoredInput, "ignored input requested a render");

			const enhancedCtrlShiftDPress = "\x1b[100;6u";
			const enhancedCtrlShiftDRelease = "\x1b[100;6:3u";
			assert.deepEqual(terminalInput(enhancedCtrlShiftDPress), { consume: true });
			assert.deepEqual(terminalInput(enhancedCtrlShiftDRelease), { consume: true });
			assert.equal(liveInvalidations, 2, "Ctrl+Shift+D press and release did not toggle the live row exactly once");
			assert.equal(renderRequests, renderRequestsBeforeIgnoredInput, "Pi 0.83 widget updates must not call requestRender directly");
			assert.match(liveRenderFromInvalidation, /second output line/, "raw input toggle did not use controller state");
			assert.match(renderText(liveContext, false), /second output line/, "raw input did not expand the live row");

			let rebuiltInvalidations = 0;
			let rebuiltRenderFromInvalidation = "";
			let rebuiltContext;
			rebuiltContext = {
				state: {},
				toolCallId: "subagent-row",
				invalidate() {
					rebuiltInvalidations++;
					rebuiltRenderFromInvalidation = renderText(rebuiltContext, true);
				},
			};
			const unconfirmedRebuiltRender = renderText(rebuiltContext, false);
			assert.equal(rebuiltInvalidations, 0, "rebuilt probe ran inside renderResult");
			assert.doesNotMatch(unconfirmedRebuiltRender, /second output line/, "unconfirmed rebuilt row ignored Pi options.expanded");
			await Promise.resolve();
			assert.equal(rebuiltInvalidations, 1, "rebuilt row was not probed after renderResult");
			assert.match(rebuiltRenderFromInvalidation, /second output line/, "probe re-entry did not use controller state");
			assert.match(renderText(rebuiltContext, false), /second output line/, "confirmed rebuilt row followed Pi options.expanded");

			shortcut.handler(ctx);
			assert.equal(liveInvalidations, 2, "stale live row remained registered after reclaim");
			assert.equal(rebuiltInvalidations, 2, "rebuilt row was not invalidated after reclaim");
			assert.doesNotMatch(rebuiltRenderFromInvalidation, /second output line/, "rebuilt row ignored collapsed controller state");
			assert.doesNotMatch(renderText(rebuiltContext, true), /second output line/, "Pi options.expanded drove rebuilt live row");
			assert.doesNotMatch(renderText(htmlExportContext, false), /second output line/, "controller state leaked into collapsed HTML");
			assert.match(renderText(htmlExportContext, true), /second output line/, "expanded HTML lost full output");

			const rebuiltInvalidationsBeforeTree = rebuiltInvalidations;
			await emitExtensionEvent("session_tree", { type: "session_tree", newLeafId: "leaf" }, ctx);
			shortcut.handler(ctx);
			assert.equal(rebuiltInvalidations, rebuiltInvalidationsBeforeTree, "session_tree retained an old tool row");
			const treeFirstRender = renderText(rebuiltContext, false);
			assert.doesNotMatch(treeFirstRender, /second output line/, "unconfirmed tree row ignored Pi options.expanded");
			await Promise.resolve();
			assert.equal(rebuiltInvalidations, rebuiltInvalidationsBeforeTree + 1, "row did not probe after session_tree");
			assert.match(rebuiltRenderFromInvalidation, /second output line/, "tree probe did not use controller state");

			const rebuiltInvalidationsBeforeCompact = rebuiltInvalidations;
			await emitExtensionEvent("session_compact", { type: "session_compact" }, ctx);
			shortcut.handler(ctx);
			assert.equal(rebuiltInvalidations, rebuiltInvalidationsBeforeCompact, "session_compact retained an old tool row");
			const compactFirstRender = renderText(rebuiltContext, true);
			assert.match(compactFirstRender, /second output line/, "unconfirmed compact row ignored Pi options.expanded");
			await Promise.resolve();
			assert.equal(rebuiltInvalidations, rebuiltInvalidationsBeforeCompact + 1, "row did not probe after session_compact");
			assert.doesNotMatch(rebuiltRenderFromInvalidation, /second output line/, "compact probe did not use controller state");
			assert.doesNotMatch(renderText(rebuiltContext, true), /second output line/, "confirmed compact row followed Pi options.expanded");

			assert.equal(piExpansionChanges, 0, "shortcut mutated Pi tool expansion");
			assert.equal(renderRequests, 0, "Pi 0.83 widget updates must not call requestRender directly");
			const rebuiltInvalidationsBeforeReset = rebuiltInvalidations;
			const replacementCtx = makeContext("replacement-session");
			await emitExtensionEvent("session_start", { type: "session_start", reason: "resume" }, replacementCtx);
			assert.equal(terminalInputUnsubscribeCalls.get("live-detail-session"), 1, "session reset did not unsubscribe the old raw listener once");
			assert.equal(terminalInputHandlers.has("live-detail-session"), false, "session reset retained the old raw listener");
			assert.equal(typeof terminalInputHandlers.get("replacement-session"), "function", "session reset did not reinstall the raw listener");
			shortcut.handler(replacementCtx);
			assert.equal(rebuiltInvalidations, rebuiltInvalidationsBeforeReset, "session reset retained an old tool row");
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

	it("keeps one result block when the pinned ToolExecutionComponent registers and reclaims", () => {
		const script = String.raw`
			import assert from "node:assert/strict";
			import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
			import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
			import registerSubagentExtension from "./src/extension/index.ts";
			import { SUBAGENT_LIVE_DETAIL_SHORTCUT } from "./src/shared/subagent-shortcuts.ts";

			initTheme("dark");
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
			const shortcut = shortcuts.get(SUBAGENT_LIVE_DETAIL_SHORTCUT);
			assert.ok(shortcut, "Ctrl+Shift+D shortcut was not registered");

			let renderRequests = 0;
			const ctx = {
				cwd: process.cwd(),
				hasUI: true,
				ui: {
					setWidget() {},
					requestRender() { renderRequests++; },
					setToolsExpanded() { throw new Error("unexpected Pi expansion mutation"); },
					theme: {
						fg(_name, text) { return text; },
						bg(_name, text) { return text; },
						bold(text) { return text; },
					},
				},
				sessionManager: {
					getSessionId() { return "tool-component-session"; },
					getSessionFile() { return null; },
					getEntries() { return []; },
				},
				modelRegistry: { getAvailable() { return []; } },
			};
			const emitExtensionEvent = async (type, event) => {
				for (const handler of extensionHandlers.get(type) ?? []) await handler(event, ctx);
			};
			await emitExtensionEvent("session_start", { type: "session_start", reason: "startup" });

			const output = ["first output line", "second output line"].join(String.fromCharCode(10));
			const result = {
				content: [{ type: "text", text: output }],
				details: {
					mode: "single",
					results: [{
						agent: "worker",
						task: "Check ToolExecutionComponent composition",
						exitCode: 0,
						messages: [],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						finalOutput: output,
					}],
				},
				isError: false,
			};
			const resultBlockCount = (component) => component
				.render(180)
				.join(String.fromCharCode(10))
				.split("first output line").length - 1;

			let initialComponentRenders = 0;
			const initialComponent = new ToolExecutionComponent(
				"subagent",
				"actual-tool-row",
				{ agent: "worker", task: "Check ToolExecutionComponent composition" },
				{ showImages: false },
				registeredTool,
				{ requestRender() { initialComponentRenders++; } },
				process.cwd(),
			);
			initialComponent.updateResult(result, false);
			assert.equal(initialComponentRenders, 0, "initial probe ran during ToolExecutionComponent.updateResult");
			assert.equal(resultBlockCount(initialComponent), 1, "initial outer render duplicated the result block");
			await Promise.resolve();
			assert.equal(initialComponentRenders, 1, "initial deferred probe did not invalidate the component once");
			assert.equal(resultBlockCount(initialComponent), 1, "initial deferred probe duplicated the result block");

			let rebuiltComponentRenders = 0;
			const rebuiltComponent = new ToolExecutionComponent(
				"subagent",
				"actual-tool-row",
				{ agent: "worker", task: "Check ToolExecutionComponent composition" },
				{ showImages: false },
				registeredTool,
				{ requestRender() { rebuiltComponentRenders++; } },
				process.cwd(),
			);
			rebuiltComponent.updateResult(result, false);
			assert.equal(rebuiltComponentRenders, 0, "rebuilt probe ran during ToolExecutionComponent.updateResult");
			assert.equal(resultBlockCount(rebuiltComponent), 1, "rebuilt outer render duplicated the result block");
			await Promise.resolve();
			assert.equal(rebuiltComponentRenders, 1, "rebuilt row did not run one deferred reclaim probe");
			assert.equal(resultBlockCount(rebuiltComponent), 1, "rebuilt reclaim duplicated the result block");

			const initialRendersBeforeToggle = initialComponentRenders;
			shortcut.handler(ctx);
			assert.equal(initialComponentRenders, initialRendersBeforeToggle, "successful reclaim retained the old component");
			assert.equal(rebuiltComponentRenders, 2, "shortcut did not invalidate the rebuilt component");
			const rebuiltText = rebuiltComponent.render(180).join(String.fromCharCode(10));
			assert.equal(resultBlockCount(rebuiltComponent), 1, "shortcut invalidation duplicated the rebuilt result block");
			assert.match(rebuiltText, /second output line/, "rebuilt component did not use controller detail");
			assert.equal(renderRequests, 0, "Pi 0.83 widget updates must not call requestRender directly");

			await emitExtensionEvent("session_shutdown", { type: "session_shutdown", reason: "quit" });
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

	it("shows async badge for direct async single and parallel calls", () => {
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
			const asyncParallel = registeredTool.renderCall({ tasks: [{ agent: "worker" }, { agent: "reviewer", count: 2 }], async: true }, theme).text;
			if (!asyncSingle.includes("[async]")) throw new Error("expected async single badge, got " + asyncSingle);
			if (!asyncParallel.includes("parallel (3) [async]")) throw new Error("expected async parallel badge, got " + asyncParallel);
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
