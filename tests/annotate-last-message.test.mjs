import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { findLastAssistantMessage } = await jiti.import("../extensions/the-last-harness/annotate-last-message/session.ts");
const {
	ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION,
	buildAnnotateLastMessageCommand,
	registerAnnotateLastMessageCommand,
} = await jiti.import("../extensions/the-last-harness/annotate-last-message.ts");
const { hasAnnotateLastMessageFeedback } = await jiti.import("../extensions/the-last-harness/annotate-last-message/prompt.ts");

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

test("findLastAssistantMessage reports a missing assistant message for an empty branch", () => {
	assert.deepEqual(findLastAssistantMessage([]), {
		ok: false,
		code: "missing",
		message: "No assistant messages found on the current session branch.",
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

