import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { composeAnnotateLastMessagePrompt, hasAnnotateLastMessageFeedback } = await jiti.import(
	"../extensions/the-last-harness/annotate-last-message/prompt.ts",
);
const { findLastAssistantMessage } = await jiti.import("../extensions/the-last-harness/annotate-last-message/session.ts");
const {
	ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION,
	buildAnnotateLastMessageCommand,
	registerAnnotateLastMessageCommand,
} = await jiti.import("../extensions/the-last-harness/annotate-last-message.ts");

class FakeWindow extends EventEmitter {
	constructor() {
		super();
		this.closeCalls = 0;
	}

	close() {
		this.closeCalls += 1;
		this.emit("closed");
	}
}

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function messageEntry(role, content, stopReason = "stop") {
	return {
		type: "message",
		message: {
			role,
			stopReason,
			content,
		},
	};
}

function createContext({ branch = [], editorText = "" } = {}) {
	const notifications = [];
	const pasted = [];
	return {
		notifications,
		pasted,
		ctx: {
			hasUI: true,
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
				getEditorText() {
					return editorText;
				},
				pasteToEditor(text) {
					pasted.push(text);
				},
			},
			sessionManager: {
				getBranch() {
					return branch;
				},
			},
		},
	};
}

async function flushAsyncWork() {
	await new Promise((resolve) => setImmediate(resolve));
}

test("registerAnnotateLastMessageCommand reuses the exported command builder and description", () => {
	let registeredCommand;
	let sessionShutdownHandler;
	registerAnnotateLastMessageCommand({
		registerCommand(name, command) {
			if (name === "annotate-last-message") {
				registeredCommand = command;
			}
		},
		on(event, handler) {
			if (event === "session_shutdown") {
				sessionShutdownHandler = handler;
			}
		},
	});

	assert.equal(registeredCommand.description, ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION);
	assert.equal(typeof registeredCommand.handler, "function");
	assert.equal(typeof sessionShutdownHandler, "function");

	const builtCommand = buildAnnotateLastMessageCommand();
	assert.equal(typeof builtCommand.handler, "function");
	assert.equal(typeof builtCommand.handleSessionShutdown, "function");
	assert.doesNotThrow(() => builtCommand.handleSessionShutdown());
});

test("findLastAssistantMessage reports stable diagnostics for missing, incomplete, and empty messages", () => {
	assert.deepEqual(findLastAssistantMessage([]), {
		ok: false,
		code: "missing",
		message: "No assistant messages found on the current session branch.",
	});

	assert.deepEqual(findLastAssistantMessage([messageEntry("assistant", [{ type: "text", text: "Still running" }], "max_tokens")]), {
		ok: false,
		code: "incomplete",
		message: "Latest assistant message is incomplete (max_tokens). Wait for it to finish, then try again.",
	});

	assert.deepEqual(findLastAssistantMessage([messageEntry("assistant", [{ type: "image", source: "ignored" }])]), {
		ok: false,
		code: "empty",
		message: "Latest assistant message has no text to annotate.",
	});
});

test("findLastAssistantMessage selects the latest completed assistant message on the active branch", () => {
	const result = findLastAssistantMessage([
		{ type: "branch", branchId: "root" },
		messageEntry("assistant", [{ type: "text", text: "Earlier assistant reply" }]),
		messageEntry("user", [{ type: "text", text: "Question" }]),
		{ type: "tool_call", toolName: "bash" },
		messageEntry("assistant", [{ type: "text", text: "Latest assistant reply" }]),
		messageEntry("user", [{ type: "text", text: "Follow-up" }]),
	]);

	assert.equal(result.ok, true);
	assert.equal(result.data.text, "Latest assistant reply");
	assert.deepEqual(result.data.lines, [{ number: 1, text: "Latest assistant reply" }]);
});

test("findLastAssistantMessage extracts text blocks into normalized lines and sections", () => {
	const result = findLastAssistantMessage([
		messageEntry("assistant", [
			{ type: "text", text: "Intro line\r\nDetail line" },
			{ type: "image", source: "ignored" },
			{ type: "text", text: "Third line\n\nClosing line" },
		]),
	]);

	assert.equal(result.ok, true);
	assert.equal(result.data.text, "Intro line\nDetail line\nThird line\n\nClosing line");
	assert.deepEqual(result.data.lines, [
		{ number: 1, text: "Intro line" },
		{ number: 2, text: "Detail line" },
		{ number: 3, text: "Third line" },
		{ number: 4, text: "" },
		{ number: 5, text: "Closing line" },
	]);
	assert.deepEqual(result.data.sections, [
		{
			id: "section-1",
			index: 1,
			startLine: 1,
			endLine: 3,
			preview: "Intro line",
			text: "Intro line\nDetail line\nThird line",
		},
		{
			id: "section-2",
			index: 2,
			startLine: 5,
			endLine: 5,
			preview: "Closing line",
			text: "Closing line",
		},
	]);
});

test("composeAnnotateLastMessagePrompt trims and orders overall, section, inline, and unknown-reference comments", () => {
	const prompt = composeAnnotateLastMessagePrompt(
		{
			text: "Alpha\nBeta\n\nGamma",
			lines: [
				{ number: 1, text: "Alpha" },
				{ number: 2, text: "Beta" },
				{ number: 3, text: "" },
				{ number: 4, text: "Gamma" },
			],
			sections: [
				{ id: "section-1", index: 1, startLine: 1, endLine: 2, preview: "Alpha", text: "Alpha\nBeta" },
				{ id: "section-2", index: 2, startLine: 4, endLine: 4, preview: "Gamma", text: "Gamma" },
			],
		},
		{
			type: "submit",
			overallComment: "  Tighten the plan.  ",
			sectionComments: [
				{ sectionId: "missing", body: "  Unknown section still needs attention.  " },
				{ sectionId: "section-2", body: "  Clarify the ending.  " },
				{ sectionId: "section-1", body: "" },
			],
			inlineComments: [
				{ line: 99, body: "  Missing line reference.  " },
				{ line: 2, body: "  Cite the assumption.  " },
				{ line: 1, body: "\n\t" },
			],
		},
	);

	assert.equal(
		prompt,
		[
			"Please revisit your last assistant message using the annotation feedback below.",
			"",
			"Treat this as planning-oriented feedback:",
			"- update your explanation, plan, or proposed approach in chat;",
			"- do not assume any code or file changes have already been applied;",
			"- do not auto-apply anything outside the normal response flow.",
			"",
			"## Overall guidance",
			"Tighten the plan.",
			"",
			"## Section comments",
			"1. Section 2 (line 4) — “Gamma”",
			"   Clarify the ending.",
			"",
			"2. Unknown section",
			"   Unknown section still needs attention.",
			"",
			"## Inline comments",
			"1. line 2 — “Beta”",
			"   Cite the assumption.",
			"",
			"2. line 99 — “(blank line)”",
			"   Missing line reference.",
			"",
			"Please respond by revising your last message or its plan in chat, incorporating the feedback above.",
		].join("\n"),
	);
});

test("hasAnnotateLastMessageFeedback ignores whitespace-only feedback and accepts trimmed comments", () => {
	assert.equal(
		hasAnnotateLastMessageFeedback({
			type: "submit",
			overallComment: "   ",
			inlineComments: [{ line: 2, body: "\n\t" }],
			sectionComments: [{ sectionId: "section-1", body: "  " }],
		}),
		false,
	);

	assert.equal(
		hasAnnotateLastMessageFeedback({
			type: "submit",
			overallComment: "   ",
			inlineComments: [{ line: 2, body: "  Tighten this step.  " }],
			sectionComments: [],
		}),
		true,
	);
});

test("annotate-last-message ignores malformed and primitive window messages", async () => {
	const window = new FakeWindow();
	const command = buildAnnotateLastMessageCommand({
		openAnnotationWindow: async () => window,
	});
	const context = createContext({ branch: [messageEntry("assistant", [{ type: "text", text: "Latest reply" }])] });

	await command.handler("", context.ctx);
	const invalidInlineLinePayloads = [0, -1, 1.5].map((line) => ({
		type: "submit",
		overallComment: "bad",
		inlineComments: [{ line, body: "oops" }],
		sectionComments: [],
	}));
	for (const payload of [
		null,
		undefined,
		0,
		"text",
		{},
		{ type: "submit" },
		{ type: "submit", overallComment: "bad", inlineComments: [], sectionComments: {} },
		{ type: "submit", overallComment: "bad", inlineComments: [{ line: "2", body: "oops" }], sectionComments: [] },
		...invalidInlineLinePayloads,
		{ type: "submit", overallComment: "bad", inlineComments: [], sectionComments: [{ sectionId: 1, body: "oops" }] },
	]) {
		assert.doesNotThrow(() => {
			window.emit("message", payload);
		});
	}

	await flushAsyncWork();
	assert.deepEqual(context.pasted, []);
	assert.deepEqual(context.notifications, [{ message: "Opened native annotation window.", level: "info" }]);
	command.handleSessionShutdown();
});

test("annotate-last-message blocks concurrent opens until the first annotation window resolves", async () => {
	const openDeferred = createDeferred();
	const window = new FakeWindow();
	let openCalls = 0;
	const command = buildAnnotateLastMessageCommand({
		openAnnotationWindow: async () => {
			openCalls += 1;
			return openDeferred.promise;
		},
	});
	const context = createContext({ branch: [messageEntry("assistant", [{ type: "text", text: "Latest reply" }])] });

	const first = command.handler("", context.ctx);
	await Promise.resolve();
	await command.handler("", context.ctx);
	assert.equal(openCalls, 1);
	assert.deepEqual(context.notifications, [{ message: "A last-message annotation window is already open.", level: "warning" }]);

	openDeferred.resolve(window);
	await first;
	assert.equal(context.notifications.at(-1)?.message, "Opened native annotation window.");
	command.handleSessionShutdown();
});

test("annotate-last-message cancels a pending open on shutdown without blocking a later invocation", async () => {
	const firstOpen = createDeferred();
	const firstWindow = new FakeWindow();
	const secondWindow = new FakeWindow();
	let openCalls = 0;
	const command = buildAnnotateLastMessageCommand({
		openAnnotationWindow: async () => {
			openCalls += 1;
			return openCalls === 1 ? firstOpen.promise : secondWindow;
		},
	});
	const context = createContext({ branch: [messageEntry("assistant", [{ type: "text", text: "Latest reply" }])] });

	const interrupted = command.handler("", context.ctx);
	await flushAsyncWork();
	assert.equal(openCalls, 1);

	command.handleSessionShutdown();
	await command.handler("", context.ctx);
	assert.equal(openCalls, 2);
	assert.equal(secondWindow.closeCalls, 0);

	firstOpen.resolve(firstWindow);
	await interrupted;
	assert.equal(firstWindow.closeCalls, 1);
	assert.equal(
		context.notifications.filter(({ message }) => message === "Opened native annotation window.").length,
		1,
	);

	command.handleSessionShutdown();
	assert.equal(secondWindow.closeCalls, 1);
});

test("annotate-last-message suppresses terminal results settled immediately before shutdown", async (t) => {
	const terminalEvents = [
		{
			name: "submit",
			emit(window) {
				window.emit("message", {
					type: "submit",
					overallComment: "Queued feedback",
					inlineComments: [],
					sectionComments: [],
				});
			},
		},
		{
			name: "error",
			emit(window) {
				window.emit("error", new Error("queued failure"));
			},
		},
	];

	for (const terminalEvent of terminalEvents) {
		await t.test(terminalEvent.name, async () => {
			const window = new FakeWindow();
			const command = buildAnnotateLastMessageCommand({
				openAnnotationWindow: async () => window,
			});
			const context = createContext({ branch: [messageEntry("assistant", [{ type: "text", text: "Latest reply" }])] });

			await command.handler("", context.ctx);
			terminalEvent.emit(window);
			command.handleSessionShutdown();
			await flushAsyncWork();

			assert.equal(window.closeCalls, 0);
			assert.deepEqual(context.pasted, []);
			assert.deepEqual(context.notifications, [{ message: "Opened native annotation window.", level: "info" }]);
		});
	}
});

test("annotate-last-message suppresses late submit and error events after shutdown", async () => {
	const timers = [];
	const window = new FakeWindow();
	const command = buildAnnotateLastMessageCommand({
		openAnnotationWindow: async () => window,
		setTimeoutFn: (fn) => {
			timers.push(fn);
			return timers.length;
		},
		clearTimeoutFn: () => {},
	});
	const context = createContext({ branch: [messageEntry("assistant", [{ type: "text", text: "Latest reply" }])] });

	await command.handler("", context.ctx);
	command.handleSessionShutdown();
	window.emit("error", new Error("too late"));
	window.emit("message", {
		type: "submit",
		overallComment: "Late feedback",
		inlineComments: [],
		sectionComments: [],
	});
	for (const timer of timers) {
		timer();
	}
	await flushAsyncWork();

	assert.equal(window.closeCalls, 1);
	assert.deepEqual(context.pasted, []);
	assert.deepEqual(context.notifications, [{ message: "Opened native annotation window.", level: "info" }]);
});

test("annotate-last-message appends feedback with a separating blank line when the editor already has text", async () => {
	const window = new FakeWindow();
	const command = buildAnnotateLastMessageCommand({
		openAnnotationWindow: async () => window,
	});
	const context = createContext({
		branch: [messageEntry("assistant", [{ type: "text", text: "Alpha\n\nBeta" }])],
		editorText: "Existing draft",
	});

	await command.handler("", context.ctx);
	window.emit("message", {
		type: "submit",
		overallComment: "  Tighten the structure.  ",
		inlineComments: [],
		sectionComments: [],
	});
	await flushAsyncWork();

	assert.equal(context.pasted.length, 1);
	assert.match(context.pasted[0], /^\n\nPlease revisit your last assistant message/);
	assert.equal(context.notifications.at(-1)?.message, "Appended annotation feedback to the editor.");
});
