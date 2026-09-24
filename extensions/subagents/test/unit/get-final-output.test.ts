import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxContentBlock } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalOutput } from "../../src/shared/utils.ts";

function assistantContent(content: FauxContentBlock[]): Message {
  return fauxAssistantMessage(content);
}

describe("getFinalOutput", () => {
  it("uses the last non-empty text part in the latest assistant message", () => {
    const messages = [
      assistantContent([
        { type: "text", text: "" },
        { type: "text", text: "Summary" },
      ]),
    ];

    assert.equal(getFinalOutput(messages), "Summary");
  });

  it("prefers final text over progress text in a multi-part assistant message", () => {
    const messages = [
      assistantContent([
        { type: "text", text: "Working on the fix..." },
        { type: "thinking", thinking: "Cursor shell: shell $ npm test" },
        { type: "text", text: "Implemented: patch applied." },
      ]),
    ];

    assert.equal(getFinalOutput(messages), "Implemented: patch applied.");
  });

  it("falls back to an older assistant message when the latest text is empty or tool-only", () => {
    const messages = [
      assistantContent([{ type: "text", text: "Earlier" }]),
      assistantContent([{ type: "text", text: " \n\t " }]),
      assistantContent([fauxToolCall("read", { path: "README.md" })]),
    ];

    assert.equal(getFinalOutput(messages), "Earlier");
  });

  it("returns empty output when all assistant text is empty or whitespace-only", () => {
    const messages = [
      assistantContent([{ type: "text", text: "" }]),
      assistantContent([{ type: "text", text: "\n\t " }]),
    ];

    assert.equal(getFinalOutput(messages), "");
  });

  it("does not use provider-error assistant text as fallback output", () => {
    const messages = [
      fauxAssistantMessage(
        { type: "text", text: "temporary provider failure" },
        { stopReason: "error", errorMessage: "provider transport failed" },
      ),
      assistantContent([{ type: "text", text: "" }]),
    ];

    assert.equal(getFinalOutput(messages), "");
  });

  it("preserves surrounding whitespace on the selected non-empty text", () => {
    const messages = [assistantContent([{ type: "text", text: " \n Summary \n " }])];

    assert.equal(getFinalOutput(messages), " \n Summary \n ");
  });

  it("keeps fenced child output as ordinary final text", () => {
    const fenced = "Implementation complete.\n\n```child-output\n{...}\n```";
    const messages = [assistantContent([{ type: "text", text: fenced }])];

    assert.equal(getFinalOutput(messages), fenced);
  });

  it("preserves historical report-looking fences without parsing or stripping them", () => {
    const fenced = '```acceptance-report\n{"legacy":true}\n```';
    const messages = [assistantContent([{ type: "text", text: fenced }])];

    assert.equal(getFinalOutput(messages), fenced);
  });

  it("keeps the final fenced child output when earlier parts precede it", () => {
    const prose = "Here is the detailed summary of what changed and why.";
    const fenced = "```child-output\n{...}\n```";
    const messages = [
      assistantContent([
        { type: "text", text: prose },
        { type: "thinking", thinking: "scratchpad reasoning" },
        { type: "text", text: "Second paragraph." },
        { type: "text", text: fenced },
      ]),
    ];

    assert.equal(getFinalOutput(messages), fenced);
  });

  it("does not walk back into earlier assistant messages for preceding prose", () => {
    const messages = [
      assistantContent([{ type: "text", text: "Earlier unrelated message." }]),
      assistantContent([{ type: "text", text: "```child-output\n{}\n```" }]),
    ];

    assert.equal(getFinalOutput(messages), "```child-output\n{}\n```");
  });
});
