import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxContentBlock } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalOutput } from "../../src/shared/utils.ts";
import { analyzeAcceptanceOutput } from "../../src/runs/shared/acceptance.ts";

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

  it("aggregates all non-empty text parts in a multi-part assistant message (tlhm-t34y)", () => {
    // Before tlhm-t34y: only the last text part was returned.
    // After tlhm-t34y: all non-empty text parts are joined with "\n\n".
    // Non-text parts (thinking) are ignored; empty text parts are skipped.
    const messages = [
      assistantContent([
        { type: "text", text: "Working on the fix..." },
        { type: "thinking", thinking: "Cursor shell: shell $ npm test" },
        { type: "text", text: "Implemented: patch applied." },
      ]),
    ];

    assert.equal(getFinalOutput(messages), "Working on the fix...\n\nImplemented: patch applied.");
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

// ─── Prose-mention vs real-report discrimination ────────────────────────────
//
// Regression tests for tlhm-fah8: a text part that merely *mentions* the
// acceptance marker in prose must never supersede an earlier part that carries
// a genuine acceptance report. tlhm-t34y removed `containsAcceptanceReport`
// entirely: getFinalOutput no longer runs per-part analysis; it aggregates all
// text parts and a single analyzeAcceptanceOutput call determines the result.

describe("getFinalOutput mention-only vs real-report discrimination", () => {
  it("treats a prose mention of ACCEPTANCE_REPORT: (no JSON body) as a plain text part", () => {
    // The mention-only part must NOT trigger report-part selection logic.
    const mention = "By the way I should mention ACCEPTANCE_REPORT: is the marker we use.";
    const messages = [assistantContent([{ type: "text", text: mention }])];

    // No report found — falls back to the last non-empty text part.
    assert.equal(getFinalOutput(messages), mention);
  });

  it("returns aggregate of [report-part, prose-mention-part]; report identity is preserved", () => {
    // tlhm-fah8 concerned the mention being treated as an acceptance report.
    // With aggregation (tlhm-t34y): all parts are joined, the report is still found
    // in the aggregate by analyzeAcceptanceOutput, and the prose mention is preserved.
    const mention = "By the way I should mention ACCEPTANCE_REPORT: is the marker we use.";
    const messages = [
      assistantContent([
        { type: "text", text: REPORT_BLOCK },
        { type: "text", text: mention },
      ]),
    ];

    // Aggregate includes both parts; report is non-terminal but still recognized.
    assert.equal(getFinalOutput(messages), `${REPORT_BLOCK}\n\n${mention}`);
  });

  it("returns the real report when both a real report and a prose mention are present in the same message", () => {
    // Variant: mention first, then real report in a later part.
    const mention = "Note: ACCEPTANCE_REPORT: follows below.";
    const messages = [
      assistantContent([
        { type: "text", text: mention },
        { type: "text", text: REPORT_BLOCK },
      ]),
    ];

    // The real report part is the last part, and it contains a valid report.
    assert.equal(getFinalOutput(messages), `${mention}\n\n${REPORT_BLOCK}`);
  });

  it("returns aggregate of all parts when neither part contains a real acceptance report (tlhm-t34y)", () => {
    // With aggregation: all non-empty text parts are joined with "\n\n".
    // Before tlhm-t34y: fell back to the last non-empty text part.
    const partA = "First summary paragraph.";
    const partB = "ACCEPTANCE_REPORT: is just a word here, no JSON follows.";
    const messages = [
      assistantContent([
        { type: "text", text: partA },
        { type: "text", text: partB },
      ]),
    ];

    // No report detected — returns the aggregate of all non-empty text parts.
    assert.equal(getFinalOutput(messages), `${partA}\n\n${partB}`);
  });
});

// NOTE (tlhm-t34y): The original draft-block filtering behaviour — dropping a
// preceding acceptance-report part via `!containsAcceptanceReport` — has been
// replaced by full aggregation. The draft IS now included in the returned string,
// but it does NOT corrupt acceptance evaluation: analyzeAcceptanceOutput in
// execution.ts applies the terminal-wins rule, so the later REPORT_BLOCK (terminal)
// supersedes the earlier DRAFT_REPORT_BLOCK. The tests below assert the new
// aggregation expectations.
describe("getFinalOutput draft-block aggregation (tlhm-t34y, was: draft-block filtering)", () => {
  it("returns aggregate [draft-block, final-block]; acceptance evaluation still selects final", () => {
    // With aggregation, the draft is no longer dropped. The aggregate contains both;
    // analyzeAcceptanceOutput in execution.ts selects the terminal REPORT_BLOCK.
    const messages = [
      assistantContent([
        { type: "text", text: DRAFT_REPORT_BLOCK },
        { type: "text", text: REPORT_BLOCK },
      ]),
    ];

    assert.equal(getFinalOutput(messages), `${DRAFT_REPORT_BLOCK}\n\n${REPORT_BLOCK}`);
  });

  it("returns aggregate [prose, draft-block, final-block]; all three parts present", () => {
    // Prose before the draft is preserved, the draft is included, and the final
    // block is terminal — acceptance evaluation in execution.ts selects REPORT_BLOCK.
    const prose = "Here is the final summary of changes.";
    const messages = [
      assistantContent([
        { type: "text", text: prose },
        { type: "text", text: DRAFT_REPORT_BLOCK },
        { type: "text", text: REPORT_BLOCK },
      ]),
    ];

    assert.equal(getFinalOutput(messages), `${prose}\n\n${DRAFT_REPORT_BLOCK}\n\n${REPORT_BLOCK}`);
  });
});

// ─── Cross-message candidate authority (tlhm-xwtc) ──────────────────────────
//
// getFinalOutput must agree with the fence-layer rule: the newest candidate has
// authority regardless of validity. Scanning stops at the latest message that
// contains ANY candidate (valid or invalid); candidate-free messages are skipped.
//
// Identity tokens in the report bodies prove *which* message was returned.

// An invalid tagged fence: the body `{}` has no report fields, so
// parseAcceptanceReportBody returns errors and analyzeAcceptanceOutput returns
// status "invalid". The fence is still found as a candidate.
const INVALID_REPORT_BLOCK_XWTC = ["```acceptance-report", JSON.stringify({}), "```"].join("\n");

// A uniquely identified valid report used as the older message.
const VALID_REPORT_BLOCK_XWTC = [
  "```acceptance-report",
  JSON.stringify({
    criteriaSatisfied: [
      { id: "criterion-1", status: "satisfied", evidence: "identity-token-OLDER-valid" },
    ],
    changedFiles: ["src/file.ts"],
  }),
  "```",
].join("\n");

describe("getFinalOutput cross-message candidate authority (tlhm-xwtc)", () => {
  it("[older valid, newer invalid] returns the newer invalid aggregate — not stale valid (regression)", () => {
    // Regression for tlhm-xwtc: the old first-valid-wins rule returned the OLDER
    // valid message. The fix stops at the latest message with any candidate.
    // Asserted by identity token: the newer message's text appears in the result.
    const olderValidAggregate = `Older attempt.\n\n${VALID_REPORT_BLOCK_XWTC}`;
    const newerInvalidAggregate = `Newer attempt.\n\n${INVALID_REPORT_BLOCK_XWTC}`;
    const messages = [
      assistantContent([{ type: "text", text: olderValidAggregate }]),
      assistantContent([{ type: "text", text: newerInvalidAggregate }]),
    ];

    assert.equal(getFinalOutput(messages), newerInvalidAggregate);
  });

  it("[report, candidate-free 'Done.'] still finds the report (control case)", () => {
    // The candidate-free message must be skipped; scanning must continue to
    // find the report in the older message. This is the other half of the rule.
    // Asserted by identity token: the valid report's text appears in the result.
    const reportAggregate = `Implementation complete.\n\n${VALID_REPORT_BLOCK_XWTC}`;
    const messages = [
      assistantContent([{ type: "text", text: reportAggregate }]),
      assistantContent([{ type: "text", text: "Done." }]),
    ];

    assert.equal(getFinalOutput(messages), reportAggregate);
  });
});

// ─── Cross-message candidate authority — all three forms (tlhm-vlek) ─────────
//
// Supplements tlhm-xwtc: the cross-message newest-wins rule must hold for all
// three syntactic forms. Each newer invalid report is:
//   (a) DETECTED as a candidate — status "invalid", not "missing" (asserted
//       directly via analyzeAcceptanceOutput before the getFinalOutput check);
//   (b) Returned by getFinalOutput in preference to the older valid aggregate;
//   (c) Identified by a distinct identity token so the assertion proves WHICH
//       message was selected.
//
// CRITICAL (jsonfam trap): a bare {} or {"bad":"..."} inside a ```json fence
// is NOT an acceptance candidate — hasGenericAcceptanceReportSignal rejects it
// → status "missing". To produce a jsonfam candidate that is DETECTED but
// INVALID: include a well-formed commandsRun array (satisfies isCommandsRunArray
// in the detection sniff) and set criteriaSatisfied to a string → passes the
// shape sniff, fails validation → status "invalid".

// ── Tagged form (with identity tokens) ──────────────────────────────────────

const TAGGED_OLDER_VALID_VLEK = [
  "```acceptance-report",
  JSON.stringify({
    criteriaSatisfied: [
      {
        id: "criterion-1",
        status: "satisfied",
        evidence: "identity-token-vlek-tagged-OLDER-valid",
      },
    ],
    changedFiles: ["src/file.ts"],
  }),
  "```",
].join("\n");

// criteriaSatisfied is a string → detected (tagged fence always candidate) but
// fails validation (not an array) → status "invalid".
const TAGGED_NEWER_INVALID_VLEK = [
  "```acceptance-report",
  JSON.stringify({ criteriaSatisfied: "identity-token-vlek-tagged-NEWER-invalid" }),
  "```",
].join("\n");

describe("getFinalOutput cross-message candidate authority — tagged form (tlhm-vlek)", () => {
  it("[older valid tagged, newer invalid tagged] returns the newer invalid aggregate — identity-token asserted", () => {
    // Pre-assert: the newer invalid body is status "invalid", not "missing".
    // If criteriaSatisfied degraded to "missing" the test would pass vacuously.
    const newerInvalidAggregate = `Newer attempt.\n\n${TAGGED_NEWER_INVALID_VLEK}`;
    assert.equal(analyzeAcceptanceOutput(newerInvalidAggregate).status, "invalid");

    const olderValidAggregate = `Older attempt.\n\n${TAGGED_OLDER_VALID_VLEK}`;
    const messages = [
      assistantContent([{ type: "text", text: olderValidAggregate }]),
      assistantContent([{ type: "text", text: newerInvalidAggregate }]),
    ];
    // newerInvalidAggregate carries identity-token-vlek-tagged-NEWER-invalid;
    // returning it proves getFinalOutput did not fall back to the stale valid.
    assert.equal(getFinalOutput(messages), newerInvalidAggregate);
  });
});

// ── Json-family form ─────────────────────────────────────────────────────────

// Valid jsonfam report — older message, carries OLDER identity token.
const JSON_OLDER_VALID_VLEK = [
  "```json",
  JSON.stringify({
    criteriaSatisfied: [
      { id: "criterion-1", status: "satisfied", evidence: "identity-token-vlek-json-OLDER-valid" },
    ],
    changedFiles: ["src/file.ts"],
  }),
  "```",
].join("\n");

// Invalid jsonfam report — detected by shape sniff but fails validation.
// commandsRun as a proper array satisfies isCommandsRunArray → detection passes.
// criteriaSatisfied as a string fails validateAcceptanceReport → status "invalid".
const JSON_NEWER_INVALID_VLEK = [
  "```json",
  JSON.stringify({
    criteriaSatisfied: "identity-token-vlek-json-NEWER-invalid",
    commandsRun: [
      { command: "npm test", result: "passed", summary: "identity-token-vlek-json-NEWER-invalid" },
    ],
  }),
  "```",
].join("\n");

describe("getFinalOutput cross-message candidate authority — json-family form (tlhm-vlek)", () => {
  it("[older valid jsonfam, newer invalid jsonfam] returns the newer invalid aggregate — identity-token asserted", () => {
    // Pre-assert: the newer invalid body is status "invalid", not "missing".
    // A bare {} inside a ```json fence would be "missing" and this check would
    // catch that trap immediately.
    const newerInvalidAggregate = `Newer attempt.\n\n${JSON_NEWER_INVALID_VLEK}`;
    assert.equal(analyzeAcceptanceOutput(newerInvalidAggregate).status, "invalid");

    const olderValidAggregate = `Older attempt.\n\n${JSON_OLDER_VALID_VLEK}`;
    const messages = [
      assistantContent([{ type: "text", text: olderValidAggregate }]),
      assistantContent([{ type: "text", text: newerInvalidAggregate }]),
    ];
    // newerInvalidAggregate carries identity-token-vlek-json-NEWER-invalid;
    // returning it proves getFinalOutput did not fall back to the stale valid.
    assert.equal(getFinalOutput(messages), newerInvalidAggregate);
  });
});

// ── Prefix form ──────────────────────────────────────────────────────────────

// Valid prefix report — older message, carries OLDER identity token.
const PREFIX_OLDER_VALID_VLEK = `ACCEPTANCE_REPORT: ${JSON.stringify({
  criteriaSatisfied: [
    { id: "criterion-1", status: "satisfied", evidence: "identity-token-vlek-prefix-OLDER-valid" },
  ],
  changedFiles: ["src/file.ts"],
})}`;

// Invalid prefix report — detected (valid JSON object after marker) but fails
// validation (criteriaSatisfied is a string, not an array) → status "invalid".
const PREFIX_NEWER_INVALID_VLEK = `ACCEPTANCE_REPORT: ${JSON.stringify({
  criteriaSatisfied: "identity-token-vlek-prefix-NEWER-invalid",
})}`;

describe("getFinalOutput cross-message candidate authority — prefix form (tlhm-vlek)", () => {
  it("[older valid prefix, newer invalid prefix] returns the newer invalid aggregate — identity-token asserted", () => {
    // Pre-assert: the newer invalid body is status "invalid", not "missing".
    const newerInvalidAggregate = `Newer attempt.\n\n${PREFIX_NEWER_INVALID_VLEK}`;
    assert.equal(analyzeAcceptanceOutput(newerInvalidAggregate).status, "invalid");

    const olderValidAggregate = `Older attempt.\n\n${PREFIX_OLDER_VALID_VLEK}`;
    const messages = [
      assistantContent([{ type: "text", text: olderValidAggregate }]),
      assistantContent([{ type: "text", text: newerInvalidAggregate }]),
    ];
    // newerInvalidAggregate carries identity-token-vlek-prefix-NEWER-invalid;
    // returning it proves getFinalOutput did not fall back to the stale valid.
    assert.equal(getFinalOutput(messages), newerInvalidAggregate);
  });
});

// ── Mixed form ───────────────────────────────────────────────────────────────
//
// Oldest-wins scan must hold even when the older valid report and the newer
// invalid report use DIFFERENT syntactic forms.

describe("getFinalOutput cross-message candidate authority — mixed form (tlhm-vlek)", () => {
  it("[older valid tagged, newer invalid jsonfam] returns the newer invalid aggregate — cross-form identity-token asserted", () => {
    // Pre-assert: the jsonfam newer invalid body is status "invalid", not "missing".
    const newerInvalidAggregate = `Newer attempt.\n\n${JSON_NEWER_INVALID_VLEK}`;
    assert.equal(analyzeAcceptanceOutput(newerInvalidAggregate).status, "invalid");

    const olderValidAggregate = `Older attempt.\n\n${TAGGED_OLDER_VALID_VLEK}`;
    const messages = [
      assistantContent([{ type: "text", text: olderValidAggregate }]),
      assistantContent([{ type: "text", text: newerInvalidAggregate }]),
    ];
    // newerInvalidAggregate is json-family; olderValidAggregate is tagged.
    // Cross-form newest-wins: the newer invalid jsonfam beats the older valid tagged.
    assert.equal(getFinalOutput(messages), newerInvalidAggregate);
  });

  it("[older valid jsonfam, newer invalid prefix] returns the newer invalid aggregate — cross-form identity-token asserted", () => {
    // Pre-assert: the prefix newer invalid body is status "invalid", not "missing".
    const newerInvalidAggregate = `Newer attempt.\n\n${PREFIX_NEWER_INVALID_VLEK}`;
    assert.equal(analyzeAcceptanceOutput(newerInvalidAggregate).status, "invalid");

    const olderValidAggregate = `Older attempt.\n\n${JSON_OLDER_VALID_VLEK}`;
    const messages = [
      assistantContent([{ type: "text", text: olderValidAggregate }]),
      assistantContent([{ type: "text", text: newerInvalidAggregate }]),
    ];
    // newerInvalidAggregate is prefix; olderValidAggregate is json-family.
    // Cross-form newest-wins: the newer invalid prefix beats the older valid jsonfam.
    assert.equal(getFinalOutput(messages), newerInvalidAggregate);
  });
});
