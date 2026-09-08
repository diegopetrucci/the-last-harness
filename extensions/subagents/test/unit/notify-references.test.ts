import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_COMPLETION_MESSAGE_CHARS,
  boundedReference,
  buildCompletionDetails,
} from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { createPi } from "../support/notify-fixtures.ts";

// MAX_REFERENCE_CHARS is 500; tests use the literal value so they remain sensitive
// to changes in the constant.
const MAX_REF = 500;

describe("boundedReference", () => {
  it("returns a value of exactly MAX_REFERENCE_CHARS bytes unchanged with no marker", () => {
    const prefix = "/Users/diego/.the-last-harness/agent/sessions/run-0/";
    const filename = "session.jsonl";
    // Build a value padded to exactly 500 chars.
    const padding = MAX_REF - prefix.length - filename.length;
    const value = prefix + "x".repeat(padding) + filename;
    assert.equal(value.length, MAX_REF);
    assert.equal(boundedReference(value), value);
  });

  it("truncates a value of MAX_REFERENCE_CHARS + 1 with a middle marker", () => {
    // Put padding in the directory portion so the last segment is a recognisable filename.
    const filename = "session.jsonl";
    const base = "/Users/diego/.the-last-harness/agent/sessions/run-0-";
    // One char over the cap: padding fills the directory name, then '/' then filename.
    const padding = MAX_REF + 1 - base.length - 1 - filename.length;
    const value = `${base}${"x".repeat(padding)}/${filename}`;
    assert.equal(value.length, MAX_REF + 1);
    const result = boundedReference(value);
    assert.ok(result.length <= MAX_REF, `result length ${result.length} must be <= ${MAX_REF}`);
    assert.ok(
      result.includes("… [reference truncated] …"),
      "middle marker must appear in the truncated result",
    );
    assert.ok(
      result.endsWith(`/${filename}`),
      "trailing filename must be preserved after middle truncation",
    );
    // At least one leading character of root context must survive before the marker.
    // The exact amount varies: the tail is extended greedily, so a deeper kept tail
    // legitimately leaves a shorter head.
    const markerIndex = result.indexOf("… [reference truncated] …");
    assert.ok(
      markerIndex >= 1,
      `at least one leading character must precede the marker; got index ${markerIndex}`,
    );
    assert.ok(
      value.startsWith(result.slice(0, markerIndex)),
      "the leading portion must be a true prefix of the input",
    );
  });

  it("preserves the trailing filename for a long path with many directory segments", () => {
    // Construct a path whose directory portion is very long.
    const tail = "/artifact-output.md";
    const directory = "/Users/diego/.the-last-harness/agent/sessions/" + "nested/".repeat(80);
    const value = directory + tail.slice(1); // remove leading "/" already in directory
    const result = boundedReference(value);
    assert.ok(result.length <= MAX_REF);
    assert.ok(
      result.endsWith("/artifact-output.md"),
      `trailing filename must survive: got '${result.slice(-30)}'`,
    );
  });

  it("retains the run-id directories above a session filename, not just the final segment", () => {
    // Every session pointer in the system is named "session.jsonl", so the final segment
    // alone identifies nothing. The run-id directories above it are the discriminating part.
    const identifyingTail = "/428b3c62/run-0/session.jsonl";
    const deepPrefix = `/Users/diego/.the-last-harness/agent/sessions/${"deeply-nested-directory/".repeat(25)}`;
    const value = deepPrefix + identifyingTail.slice(1);
    assert.ok(value.length > MAX_REF, "fixture must exceed the cap to exercise truncation");

    const result = boundedReference(value);
    assert.ok(result.length <= MAX_REF, `result length ${result.length} must be <= ${MAX_REF}`);
    // The property that matters: the run id survives, not merely the shared filename.
    assert.ok(
      result.includes("428b3c62"),
      `run-id directory must survive: got '${result.slice(-60)}'`,
    );
    assert.ok(
      result.endsWith(identifyingTail),
      `full identifying tail must survive: got '${result.slice(-60)}'`,
    );
    assert.ok(result.includes("… [reference truncated] …"), "middle marker must be present");
    assert.ok(result.startsWith("/Users/"), "leading root context must be preserved");
  });

  it("handles a value with no path separator by falling back to head truncation with a marker", () => {
    // A non-path reference longer than the cap.
    const value = "share-error-detail-".repeat(40); // 760 chars, no "/"
    assert.ok(value.length > MAX_REF);
    const result = boundedReference(value);
    assert.ok(result.length <= MAX_REF);
    // With no separator the fallback emits the original end-of-string marker.
    assert.ok(
      result.endsWith("… [reference truncated]"),
      "no-separator fallback must end with the standard marker",
    );
    // Must not emit the middle marker whose trailing '…' implies a segment follows.
    assert.ok(
      !result.includes("… [reference truncated] …"),
      "no-separator fallback must not emit the middle marker",
    );
  });

  it("handles a value whose final segment alone exceeds the cap by falling back to head truncation", () => {
    // A path whose filename segment is itself larger than MAX_REFERENCE_CHARS.
    const hugeFilename = "x".repeat(MAX_REF + 10);
    const value = `/Users/diego/sessions/${hugeFilename}`;
    const result = boundedReference(value);
    assert.ok(result.length <= MAX_REF, `result must be within cap; got ${result.length}`);
    // The middle marker must not appear since it cannot be formed with a well-formed tail.
    assert.ok(
      !result.includes("… [reference truncated] …"),
      "oversized final segment must not produce a garbled middle marker",
    );
  });

  it("does not emit a lone surrogate when the slice boundary falls between a surrogate pair", () => {
    // Emoji U+1F600 😀 is encoded as a UTF-16 surrogate pair (two code units).
    // Construct a path where the leading budget of the middle-truncation cut falls
    // between the high and low surrogate, which would yield an ill-formed string.
    // The path must be long enough to trigger middle-truncation (> MAX_REFERENCE_CHARS).
    const emoji = "\uD83D\uDE00"; // U+1F600, two code units
    // 373 'a' chars + emoji + 40 'b' chars + '/' + 100 'z' chars
    // so the last segment is 101 chars, and the split falls just before the emoji
    const value = "a".repeat(373) + emoji + "b".repeat(40) + "/" + "z".repeat(100);
    assert.ok(value.length > MAX_REF, "fixture must exceed the cap");
    const result = boundedReference(value);
    assert.ok(result.length <= MAX_REF, `result must fit the cap; got ${result.length}`);
    // Verify no lone surrogate: every code unit in [0xD800, 0xDBFF] must be followed by
    // a code unit in [0xDC00, 0xDFFF].
    for (let i = 0; i < result.length; i++) {
      const cu = result.charCodeAt(i);
      if (cu >= 0xd800 && cu <= 0xdbff) {
        const next = result.charCodeAt(i + 1);
        assert.ok(
          next >= 0xdc00 && next <= 0xdfff,
          `lone high surrogate at index ${i}: 0x${cu.toString(16)} not followed by a low surrogate (got 0x${next.toString(16)})`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// truncateWithMarker surrogate safety — all four call sites
//
// truncateWithMarker cuts at maxChars - marker.length. When a surrogate pair
// (U+D800–U+DBFF high + U+DC00–U+DFFF low) straddles that position, a raw
// slice leaves an unpaired high surrogate at the boundary, producing an
// ill-formed string. sliceSafe enforces the invariant by backing up one code
// unit when the last retained unit is a high surrogate.
//
// CUT-POINT DERIVATION: each cut is maxChars - marker.length, derived directly
// from the function arguments.  Tests measure this from the constants rather
// than hardcoding an assumed offset so a constant change immediately breaks
// the test fixture comment, not just the assertion.
//
// COMPLETION-ENVELOPE REACHABILITY NOTE:
//   The sendCompletion envelope calls truncateWithMarker(formatted, 32000, marker33).
//   Both formatSingleCompletion and formatGroupedCompletion guarantee
//   formatted.length <= MAX_COMPLETION_MESSAGE_CHARS - 1 = 31 999 through their
//   joinedLineCost / trimEnd reservation math (the final trimEnd removes exactly
//   one trailing '\n' that joinedLineCost counts in reservedChars, leaving one
//   char of permanent slack).  Therefore truncateWithMarker's value.length check
//   always exits early for the envelope, and placing an emoji at index 31 966
//   is structurally impossible under the current formatters.  No envelope test
//   is written; this comment is the evidence.
// ---------------------------------------------------------------------------

describe("truncateWithMarker surrogate safety at each call site", () => {
  const emoji = "\uD83D\uDE00"; // U+1F600 — two UTF-16 code units

  // -----------------------------------------------------------------------
  // 1. boundedSummary  (marker = '… [summary truncated]', 21 chars)
  //    maxChars = 8 000 (MAX_SUMMARY_CHARS), cut = 8000 - 21 = 7 979
  //    High surrogate at index 7 978 is the last unit taken by the raw slice.
  // -----------------------------------------------------------------------
  it("boundedSummary: well-formed when an emoji straddles the 7979-char cut", () => {
    const summaryMarker = "… [summary truncated]";
    const maxSummaryChars = 8_000; // MAX_SUMMARY_CHARS module constant
    const cutPoint = maxSummaryChars - summaryMarker.length; // 7979
    // emoji starts at cutPoint - 1 = 7978 so the high surrogate falls at the
    // last position taken by slice(0, cutPoint).
    const summary = "a".repeat(cutPoint - 1) + emoji + "a".repeat(500);
    assert.equal(summary.length, cutPoint - 1 + 2 + 500, "fixture length sanity");

    const { events, sentMessages } = createPi();
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "surrogate-summary-test",
      agent: "test-agent",
      success: true,
      summary,
      timestamp: 1,
      sessionId: "session-1",
    });

    assert.equal(sentMessages.length, 1, "exactly one message expected");
    const content = (sentMessages[0]!.message as { content: string }).content;
    assert.ok(content.isWellFormed(), "boundedSummary output must not contain a lone surrogate");
    assert.ok(content.length <= MAX_COMPLETION_MESSAGE_CHARS, "ceiling must be respected");
  });

  // -----------------------------------------------------------------------
  // 2. boundedReference fallback — no path separator present
  //    (marker = '… [reference truncated]', 23 chars)
  //    maxChars = 500 (MAX_REFERENCE_CHARS), cut = 500 - 23 = 477
  //    High surrogate at index 476 is the last unit taken by the raw slice.
  // -----------------------------------------------------------------------
  it("boundedReference (no-separator fallback): well-formed when emoji straddles the 477-char cut", () => {
    const refMarker = "… [reference truncated]";
    const maxRefChars = 500; // MAX_REFERENCE_CHARS module constant
    const cutPoint = maxRefChars - refMarker.length; // 477
    // No '/' in the value → fallback to truncateWithMarker directly.
    const value = "a".repeat(cutPoint - 1) + emoji + "a".repeat(100);
    assert.ok(value.length > maxRefChars, "fixture must exceed the cap");
    assert.ok(!value.includes("/"), "fixture must have no path separator");

    const result = boundedReference(value);
    assert.ok(
      result.length <= maxRefChars,
      `result length ${result.length} must be <= ${maxRefChars}`,
    );
    assert.ok(
      result.isWellFormed(),
      "boundedReference (no-separator) output must not contain a lone surrogate",
    );
    assert.ok(result.endsWith(refMarker), "fallback marker must be present");
  });

  // -----------------------------------------------------------------------
  // 3. boundedReference fallback — final segment saturates the cap
  //    Same marker and cut as above (477).  Route reached when the path has a
  //    separator but the last segment is longer than
  //    MAX_REFERENCE_CHARS - middleMarker.length - 1 = 474 chars, so no
  //    leading context can survive alongside the middle marker.
  // -----------------------------------------------------------------------
  it("boundedReference (final-segment-saturates fallback): well-formed when emoji straddles the 477-char cut", () => {
    const refMarker = "… [reference truncated]";
    const maxRefChars = 500; // MAX_REFERENCE_CHARS module constant
    const cutPoint = maxRefChars - refMarker.length; // 477
    // '/' at index 0, then (cutPoint - 2) 'a's, then emoji.
    // The final segment alone (cutPoint - 2 + 2 + 100 = 577 chars) exceeds
    // MAX_REFERENCE_CHARS - middleMarker.length - 1 = 474, so the while-loop
    // breaks immediately and tailStart stays -1 → truncateWithMarker fallback.
    const value = "/" + "a".repeat(cutPoint - 2) + emoji + "a".repeat(100);
    // index 0 = '/', indices 1..(cutPoint-2) = 'a', index cutPoint-1 = high surrogate
    assert.equal(value[cutPoint - 1], "\uD83D", "high surrogate must be at index cutPoint-1");
    assert.ok(value.length > maxRefChars, "fixture must exceed the cap");

    const result = boundedReference(value);
    assert.ok(
      result.length <= maxRefChars,
      `result length ${result.length} must be <= ${maxRefChars}`,
    );
    assert.ok(
      result.isWellFormed(),
      "boundedReference (final-segment-saturates) output must not contain a lone surrogate",
    );
    assert.ok(result.endsWith(refMarker), "fallback marker must be present");
  });

  // -----------------------------------------------------------------------
  // 4. boundedLabel  (marker = '… [label truncated]', 19 chars)
  //    maxChars = 160 (MAX_LABEL_CHARS), cut = 160 - 19 = 141
  //    High surrogate at index 140 is the last unit taken by the raw slice.
  // -----------------------------------------------------------------------
  it("boundedLabel: well-formed when an emoji straddles the 141-char cut", () => {
    const labelMarker = "… [label truncated]";
    const maxLabelChars = 160; // MAX_LABEL_CHARS module constant
    const cutPoint = maxLabelChars - labelMarker.length; // 141
    // boundedLabel is applied to the agent name inside buildCompletionDetails.
    const agentName = "a".repeat(cutPoint - 1) + emoji + "a".repeat(50);
    assert.ok(agentName.length > maxLabelChars, "fixture must exceed the cap");

    const details = buildCompletionDetails({
      id: "surrogate-label-test",
      agent: agentName,
      success: true,
      summary: "",
      timestamp: 1,
    });
    assert.ok(
      details.agent.isWellFormed(),
      "boundedLabel output (details.agent) must not contain a lone surrogate",
    );
    assert.ok(details.agent.length <= maxLabelChars, "agent label must respect the cap");
    assert.ok(details.agent.endsWith(labelMarker), "label marker must be present");
  });
});
