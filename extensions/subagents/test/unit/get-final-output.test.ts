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

  it("falls back to an older assistant message when the latest text is whitespace-only", () => {
    const messages = [
      assistantContent([{ type: "text", text: "Earlier" }]),
      assistantContent([{ type: "text", text: " \n\t " }]),
    ];

    assert.equal(getFinalOutput(messages), "Earlier");
  });

  it("falls back to an older assistant message when the latest assistant message is tool-only", () => {
    const messages = [
      assistantContent([{ type: "text", text: "Earlier" }]),
      assistantContent([fauxToolCall("read", { path: "README.md" })]),
    ];

    assert.equal(getFinalOutput(messages), "Earlier");
  });

  it("prefers an earlier explicit acceptance report over later summary-only text", () => {
    const report = [
      "Done",
      "```acceptance-report",
      JSON.stringify({
        criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified" }],
        changedFiles: ["src/file.ts"],
      }),
      "```",
    ].join("\n");
    const messages = [
      assistantContent([{ type: "text", text: report }]),
      assistantContent([{ type: "text", text: "Done." }]),
    ];

    assert.equal(getFinalOutput(messages), report);
  });

  it("prefers an earlier json-fenced acceptance report over later summary-only text", () => {
    const report = [
      "Done",
      "```json",
      JSON.stringify({
        criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified" }],
        validationOutput: ["tests passed"],
      }),
      "```",
    ].join("\n");
    const messages = [
      assistantContent([{ type: "text", text: report }]),
      assistantContent([{ type: "text", text: "Done." }]),
    ];

    assert.equal(getFinalOutput(messages), report);
  });

  it("does not prefer provider-error acceptance reports", () => {
    const messages = [
      fauxAssistantMessage(
        { type: "text", text: "```acceptance-report\n{}\n```" },
        { stopReason: "error", errorMessage: "provider transport failed" },
      ),
      assistantContent([{ type: "text", text: "Done." }]),
    ];

    assert.equal(getFinalOutput(messages), "Done.");
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
});

const REPORT_BLOCK = [
  "```acceptance-report",
  JSON.stringify({
    criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "tests pass" }],
    changedFiles: ["src/file.ts"],
    commandsRun: [{ command: "npm run test:unit", result: "passed", summary: "42 pass, 0 fail" }],
  }),
  "```",
].join("\n");

describe("getFinalOutput acceptance-report part selection", () => {
  it("keeps prose that shares a text part with the acceptance-report block", () => {
    // The observed shape: one short sentence immediately followed by the block.
    const text = `Implementation complete.\n\n${REPORT_BLOCK}`;
    const messages = [assistantContent([{ type: "text", text }])];

    assert.equal(getFinalOutput(messages), text);
  });

  it("includes prose from text parts preceding the acceptance-report part in the same message", () => {
    // Regression for the reverse-iteration early return: the prose part was never
    // visited, so a narrative written in an earlier part was silently dropped.
    const prose = "Here is the detailed summary of what changed and why.";
    const messages = [
      assistantContent([
        { type: "text", text: prose },
        { type: "text", text: REPORT_BLOCK },
      ]),
    ];

    assert.equal(getFinalOutput(messages), `${prose}\n\n${REPORT_BLOCK}`);
  });

  it("joins multiple preceding prose parts in document order and keeps the block last", () => {
    const messages = [
      assistantContent([
        { type: "text", text: "First paragraph." },
        { type: "thinking", thinking: "scratchpad reasoning" },
        { type: "text", text: "Second paragraph." },
        { type: "text", text: REPORT_BLOCK },
      ]),
    ];

    assert.equal(
      getFinalOutput(messages),
      `First paragraph.\n\nSecond paragraph.\n\n${REPORT_BLOCK}`,
    );
  });

  it("does not walk back into earlier assistant messages for preceding prose", () => {
    // Guards against pulling in unrelated intermediate chatter.
    const messages = [
      assistantContent([{ type: "text", text: "Earlier unrelated message." }]),
      assistantContent([{ type: "text", text: REPORT_BLOCK }]),
    ];

    assert.equal(getFinalOutput(messages), REPORT_BLOCK);
  });
});

const DRAFT_REPORT_BLOCK = [
  "```acceptance-report",
  JSON.stringify({
    criteriaSatisfied: [
      { id: "criterion-1", status: "satisfied", evidence: "draft evidence — superseded" },
    ],
    changedFiles: ["src/file.ts"],
    commandsRun: [{ command: "npm run test:unit", result: "passed", summary: "draft run" }],
  }),
  "```",
].join("\n");

describe("getFinalOutput draft-block filtering", () => {
  it("returns only the final block when the message is shaped [draft-block, final-block]", () => {
    // Regression: a draft acceptance-report part preceding the real final block was
    // previously collected as prose and joined in, causing the stale draft to leak
    // into result.finalOutput and drive acceptance evaluation.
    const messages = [
      assistantContent([
        { type: "text", text: DRAFT_REPORT_BLOCK },
        { type: "text", text: REPORT_BLOCK },
      ]),
    ];

    assert.equal(getFinalOutput(messages), REPORT_BLOCK);
  });

  it("returns prose + final block when the message is shaped [prose, draft-block, final-block]", () => {
    // Prose before a draft must be preserved; the draft itself must be dropped.
    const prose = "Here is the final summary of changes.";
    const messages = [
      assistantContent([
        { type: "text", text: prose },
        { type: "text", text: DRAFT_REPORT_BLOCK },
        { type: "text", text: REPORT_BLOCK },
      ]),
    ];

    assert.equal(getFinalOutput(messages), `${prose}\n\n${REPORT_BLOCK}`);
  });
});
