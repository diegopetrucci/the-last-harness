import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  attachNestedChildrenToResultChildren,
  formatForegroundNativeSubagentResult,
  resolveSubagentResultStatus,
} from "../../src/shared/result-formatting.ts";
import type { SubagentResultChild } from "../../src/shared/types.ts";
import { makePublicNestedRunSummary } from "../support/helpers.ts";

describe("result formatter", () => {
  it("attaches compact nested children under their parent result child without route secrets", () => {
    // Typed as SubagentResultChild[] so T is inferred as the full interface,
    // making children (which the function attaches) accessible on the return type.
    const items: SubagentResultChild[] = [
      { agent: "owner-a", status: "completed", summary: "done", index: 0 },
      { agent: "owner-b", status: "completed", summary: "done", index: 1 },
    ];
    const children = attachNestedChildrenToResultChildren("root-run", items, [
      {
        id: "nested-a",
        parentRunId: "root-run",
        parentStepIndex: 1,
        depth: 1,
        path: [{ runId: "root-run", stepIndex: 1 }],
        state: "complete",
        agent: "reviewer",
        sessionFile: path.join(os.tmpdir(), "nested-a.jsonl"),
        controlInbox: "/tmp/should-not-leak",
        capabilityToken: "secret-token",
        children: [
          {
            id: "nested-grandchild",
            parentRunId: "nested-a",
            depth: 2,
            path: [{ runId: "root-run", stepIndex: 1 }, { runId: "nested-a" }],
            state: "complete",
            agent: "auditor",
            controlInbox: "/tmp/grandchild-should-not-leak",
            capabilityToken: "grandchild-secret",
          },
        ],
      },
    ]);

    const nested = children[1]?.children?.[0];
    const grandchild = nested?.children?.[0];
    assert.equal(children[0]?.children, undefined);
    assert.equal(nested?.id, "nested-a");
    assert.equal(Object.hasOwn(nested ?? {}, "controlInbox"), false);
    assert.equal(Object.hasOwn(nested ?? {}, "capabilityToken"), false);
    assert.equal(grandchild?.id, "nested-grandchild");
    assert.equal(Object.hasOwn(grandchild ?? {}, "controlInbox"), false);
    assert.equal(Object.hasOwn(grandchild ?? {}, "capabilityToken"), false);
  });

  it("formats native foreground results with bounded failed-first previews and explicit omissions", () => {
    const grouped = formatForegroundNativeSubagentResult({
      runId: "run-native",
      mode: "parallel",
      children: [
        {
          agent: "completed-1",
          status: "completed",
          summary: "done",
          artifactPath: "/tmp/a.md",
          index: 0,
        },
        {
          agent: "failed-1",
          status: "failed",
          summary: "failed badly",
          sessionPath: "/tmp/b.jsonl",
          index: 1,
        },
        { agent: "paused-1", status: "paused", summary: "paused output", index: 2 },
        { agent: "completed-2", status: "completed", summary: "done", index: 3 },
        { agent: "completed-3", status: "completed", summary: "done", index: 4 },
        { agent: "completed-4", status: "completed", summary: "done", index: 5 },
        { agent: "completed-5", status: "completed", summary: "done", index: 6 },
        { agent: "completed-6", status: "completed", summary: "done", index: 7 },
        { agent: "completed-7", status: "completed", summary: "done", index: 8 },
      ],
    });

    assert.equal(grouped.status, "failed");
    assert.equal(grouped.summary, "7 completed, 1 failed, 1 paused");
    assert.match(grouped.text, /^subagent results/m);
    assert.match(grouped.text, /Run: run-native/);
    assert.match(grouped.text, /Mode: parallel/);
    assert.match(grouped.text, /Status: failed/);
    assert.match(grouped.text, /Children: 7 completed, 1 failed, 1 paused/);
    assert.match(
      grouped.text,
      /2\/9\. failed-1 — failed[\s\S]*3\/9\. paused-1 — paused[\s\S]*1\/9\. completed-1 — completed/,
    );
    assert.match(
      grouped.text,
      /… \[1 child results omitted; highest-priority results shown first; full set is unavailable\]/,
    );
    assert.match(grouped.text, /Output artifact: \/tmp\/a\.md/);
    assert.match(grouped.text, /Session: \/tmp\/b\.jsonl/);
    assert.ok(grouped.text.length <= 8_000);
  });

  it("bounds native foreground errors, child summaries, and nested previews", () => {
    const grouped = formatForegroundNativeSubagentResult({
      runId: "run-native-error",
      mode: "parallel",
      statusOverride: "failed",
      errorSummary: `Collected output validation failed: ${"E".repeat(2_000)}`,
      children: [
        {
          agent: "reviewer",
          status: "failed",
          summary: "s".repeat(2_000),
          artifactPath: "/tmp/reviewer-output.md",
          children: Array.from({ length: 9 }, (_, index) => ({
            id: `nested-${index}`,
            parentRunId: "run-native-error",
            parentStepIndex: 0,
            depth: 1,
            path: [{ runId: "run-native-error", stepIndex: 0 }],
            state: "complete",
            agent: `nested-agent-${index}`,
            children: [
              {
                id: `nested-${index}-child`,
                parentRunId: `nested-${index}`,
                depth: 2,
                path: [{ runId: "run-native-error", stepIndex: 0 }, { runId: `nested-${index}` }],
                state: "complete",
                agent: `nested-child-${index}`,
                children: [
                  {
                    id: `nested-${index}-grandchild`,
                    parentRunId: `nested-${index}-child`,
                    depth: 3,
                    path: [
                      { runId: "run-native-error", stepIndex: 0 },
                      { runId: `nested-${index}` },
                      { runId: `nested-${index}-child` },
                    ],
                    state: "complete",
                    agent: `nested-grandchild-${index}`,
                  },
                ],
              },
            ],
          })),
        },
      ],
    });

    assert.equal(grouped.status, "failed");
    assert.equal(grouped.summary, "1 failed");
    assert.match(grouped.text, /Error:\nCollected output validation failed:/);
    assert.match(grouped.text, /\[error truncated; full text is unavailable\]/);
    assert.match(
      grouped.text,
      /Summary:\ns+[\s\S]*\[summary truncated; see references below for full output\]/,
    );
    assert.match(grouped.text, /Nested subagents:/);
    assert.match(grouped.text, /… \[nested depth limit reached; full tree is unavailable\]/);
    assert.match(grouped.text, /… \[additional nested entries omitted; full tree is unavailable\]/);
    assert.equal(grouped.text.match(/Collected output validation failed/g)?.length ?? 0, 1);
    assert.ok(grouped.text.length <= 8_000);
  });

  it("summary truncation is surrogate-safe in formatForegroundNativeSubagentResult", () => {
    // MEASURE the cut point by passing a long pure-ASCII summary and counting
    // how many content characters survive. This avoids hard-coding an offset
    // that might drift when constants or markers change.
    const ascii = "A".repeat(5_000);
    const measured = formatForegroundNativeSubagentResult({
      runId: "run-surr-measure",
      mode: "parallel",
      children: [{ agent: "a", status: "completed", summary: ascii, index: 0 }],
    });
    // Count how many 'A' characters survived — that is the exact cut index.
    const summarySection = measured.text.split("\nSummary:\n")[1] ?? "";
    const cutPoint = (summarySection.match(/A/g) ?? []).length;
    assert.ok(cutPoint > 0, "expected summary to be truncated with some content surviving");

    // Build a summary where an emoji's high surrogate lands exactly on the
    // final kept code-unit position (index cutPoint - 1, 0-indexed).
    // 🌍 (U+1F30D) encodes as two UTF-16 code units: high surrogate at
    // cutPoint-1 and low surrogate at cutPoint. A raw slice(0, cutPoint)
    // keeps the high surrogate but drops the low surrogate → ill-formed.
    const emoji = "\u{1F30D}"; // 🌍 — two UTF-16 code units
    const surrogateAtCut = "B".repeat(cutPoint - 1) + emoji + "C".repeat(5_000);
    const result = formatForegroundNativeSubagentResult({
      runId: "run-surr-safe",
      mode: "parallel",
      children: [{ agent: "a", status: "completed", summary: surrogateAtCut, index: 0 }],
    });
    // The formatter must produce a well-formed string — no unpaired surrogates.
    assert.ok(
      result.text.isWellFormed(),
      "summary truncation must not strand a UTF-16 high surrogate",
    );
  });

  it("resolves paused, completed, and failed statuses", () => {
    assert.equal(resolveSubagentResultStatus({ interrupted: true }), "paused");
    assert.equal(resolveSubagentResultStatus({ success: true }), "completed");
    assert.equal(resolveSubagentResultStatus({ exitCode: 1 }), "failed");
  });
});

// =========================================================================
// formatForegroundNativeSubagentText ceiling-contract sweep.
//
// Derived from measured behaviour on this file. Do NOT import notify.ts
// fixtures — the caps, scaffolding, and structure differ.
//
// Five properties are checked per combination:
//   1. Output never exceeds MAX_NATIVE_FOREGROUND_CHARS (8 000).
//   2. Every displayed child retains BOTH recovery pointers (artifact + session).
//   3. A 'Nested subagents:' heading is never emitted without content beneath it.
//   4. No mangled truncation-marker fragments (e.g. '… [su').
//   5. Output is always well-formed UTF-16.
// =========================================================================
describe("formatForegroundNativeSubagentText ceiling-contract sweep", () => {
  const ART_PATH =
    "/home/user/.the-last-harness/agent/runs/run-12345678-abcd-efgh-ijkl/artifacts/subagent-output.md";
  const SESS_PATH =
    "/home/user/.the-last-harness/agent/runs/run-12345678-abcd-efgh-ijkl/run-0/session.jsonl";
  const LONG_SUMMARY = "S".repeat(2_000); // well above MAX_NATIVE_FOREGROUND_SUMMARY_CHARS (1 200)
  const MAX_CHARS = 8_000;

  // Every marker this module emits has the shape '… [<text>]'. A bare '…' that is not
  // followed by a complete bracketed marker is a sliced fragment.
  const WELL_FORMED_MARKER = /^… \[[^[\]]*\]/;
  function assertNoMangledMarker(label: string, text: string): void {
    for (let i = text.indexOf("…"); i !== -1; i = text.indexOf("…", i + 1)) {
      assert.ok(
        WELL_FORMED_MARKER.test(text.slice(i)),
        `[${label}]: mangled marker at ${i}: ${JSON.stringify(text.slice(i, i + 40))}`,
      );
    }
  }

  // Structural well-formedness: a 'Nested subagents:' heading must never appear
  // without content beneath it. A length check alone cannot catch this because an
  // orphaned heading still fits within the ceiling while producing meaningless output.
  function assertNoOrphanedNestedHeading(label: string, text: string): void {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.trim() !== "Nested subagents:") continue;
      let j = i + 1;
      while (j < lines.length && lines[j]?.trim() === "") j++;
      const next = lines[j]?.trim() ?? "";
      // The next non-empty line must be a nested entry (↳) or an omission marker (…).
      const hasContent = next.startsWith("↳") || next.startsWith("…");
      assert.ok(
        hasContent,
        `[${label}]: orphaned 'Nested subagents:' heading at line ${i} — next non-empty line: ${JSON.stringify(next)}`,
      );
    }
  }

  function makeNestedEntry(id: string) {
    return makePublicNestedRunSummary(id, { agent: `nested-${id}` });
  }

  // -------------------------------------------------------------------------
  // Detection check for the orphaned-heading guard.
  //
  // WHAT THIS ESTABLISHES: assertNoOrphanedNestedHeading actually fires when an
  // orphaned heading is present, and does not fire on real formatter output. A
  // guard that has never failed is not evidence of anything, so the detection
  // half is exercised against a hand-built sample.
  //
  // WHAT THIS DOES NOT ESTABLISH: this formatter cannot produce an orphaned
  // heading through its current code paths, so no live formatter run is used
  // as the triggering input. The sample below is hand-built to exercise the
  // assertNoOrphanedNestedHeading helper itself.
  //
  // The guard is FORWARD-LOOKING: nested lines are computed as a unit, and a
  // future change that emits the heading and then omits the entries beneath it
  // without a marker would produce exactly the defect this guard catches.
  // -------------------------------------------------------------------------
  it("orphaned-heading guard detects a bare heading and passes on real formatter output", () => {
    // Construct text where 'Nested subagents:' is followed by a blank line and then
    // an artifact line — NOT a nested entry (↳) or omission marker (…).
    const orphanedText = [
      "subagent results",
      "",
      "Run: run-x",
      "Mode: parallel",
      "Status: completed",
      "Children: 1 completed",
      "",
      "1/1. worker — completed",
      "Summary:",
      "done",
      "Nested subagents:",
      // Blank line then non-nested-entry content: the defect.
      "",
      "Output artifact: /tmp/a.md",
    ].join("\n");

    // The guard must detect the defect.
    assert.throws(
      () => assertNoOrphanedNestedHeading("hand-built-bare-heading-sample", orphanedText),
      /orphaned/,
      "assertNoOrphanedNestedHeading must fire on text with an orphaned 'Nested subagents:' heading",
    );

    // Real formatter output must pass the same guard.
    const result = formatForegroundNativeSubagentResult({
      runId: "run-x",
      mode: "parallel",
      children: [
        {
          agent: "worker",
          status: "completed",
          summary: "done",
          index: 0,
          children: [makeNestedEntry("n1")],
        },
      ],
    });
    // Must not throw.
    assert.doesNotThrow(
      () => assertNoOrphanedNestedHeading("real-formatter-output", result.text),
      "formatter must not produce an orphaned 'Nested subagents:' heading",
    );
    // Must also have the nested entry in the output.
    assert.match(result.text, /Nested subagents:/, "nested section must appear");
    assert.match(result.text, /↳ nested-n1/, "nested entry must appear beneath the heading");
  });

  // -------------------------------------------------------------------------
  // Pointer survival sweep: 1 through 8 children.
  //
  // Every displayed child must keep both recovery pointers inside the ceiling.
  // ART_PATH is 96 chars; SESS_PATH is 87 chars. Measured output lengths with
  // 2 000-char summaries (runId="run-sweep-N"):
  //   5 children → 7333 chars, 5/5 pointers
  //   6 children → 7995 chars, 6/6 pointers
  //   8 children → 7997 chars, 8/8 pointers
  // -------------------------------------------------------------------------
  for (let n = 1; n <= 8; n++) {
    it(`${n} children: all displayed children retain both recovery pointers within the ceiling`, () => {
      const children = Array.from({ length: n }, (_, i) => ({
        agent: `worker-${i}`,
        // Put one failed child first so priority ordering exercises the sort path.
        status: (i === 0 && n > 1 ? "failed" : "completed") as "failed" | "completed",
        summary: LONG_SUMMARY,
        artifactPath: ART_PATH,
        sessionPath: SESS_PATH,
        index: i,
      }));

      const { text } = formatForegroundNativeSubagentResult({
        runId: `run-sweep-${n}`,
        mode: "parallel",
        children,
      });

      const displayedN = Math.min(n, 8); // MAX_NATIVE_FOREGROUND_CHILDREN

      // 1. Must not exceed the ceiling.
      assert.ok(
        text.length <= MAX_CHARS,
        `n=${n}: length ${text.length} exceeds ceiling ${MAX_CHARS}`,
      );

      // 2. Every displayed child must retain BOTH recovery pointers.
      const artifactCount = (text.match(/Output artifact:/g) ?? []).length;
      const sessionCount = (text.match(/Session:/g) ?? []).length;
      assert.equal(
        artifactCount,
        displayedN,
        `n=${n}: expected ${displayedN} artifact pointers, got ${artifactCount}`,
      );
      assert.equal(
        sessionCount,
        displayedN,
        `n=${n}: expected ${displayedN} session pointers, got ${sessionCount}`,
      );

      // 3. No orphaned 'Nested subagents:' headings.
      assert.doesNotThrow(
        () => assertNoOrphanedNestedHeading(`n=${n}`, text),
        `n=${n}: orphaned 'Nested subagents:' heading in output`,
      );

      // 4. No mangled truncation markers.
      assert.doesNotThrow(
        () => assertNoMangledMarker(`n=${n}`, text),
        `n=${n}: mangled truncation marker in output`,
      );

      // 5. Well-formed UTF-16.
      assert.ok(text.isWellFormed(), `n=${n}: output contains ill-formed UTF-16`);
    });
  }

  it("8 children with nested subagents: all displayed children retain pointers and no orphaned headings", () => {
    const children = Array.from({ length: 8 }, (_, i) => ({
      agent: `worker-${i}`,
      status: "completed" as const,
      summary: "S".repeat(500),
      artifactPath: ART_PATH,
      sessionPath: SESS_PATH,
      index: i,
      // Every other child has a nested subagent to exercise the heading guard.
      children: i % 2 === 0 ? [makeNestedEntry(`n${i}`)] : undefined,
    }));

    const { text } = formatForegroundNativeSubagentResult({
      runId: "run-nested-sweep",
      mode: "parallel",
      children,
    });

    assert.ok(text.length <= MAX_CHARS, `length ${text.length} exceeds ceiling`);
    assert.doesNotThrow(() => assertNoOrphanedNestedHeading("8-children-nested", text));
    assert.doesNotThrow(() => assertNoMangledMarker("8-children-nested", text));
    assert.ok(text.isWellFormed());
    // All 8 children must retain both pointers.
    assert.equal(
      (text.match(/Output artifact:/g) ?? []).length,
      8,
      "all 8 artifact pointers must survive",
    );
    assert.equal((text.match(/Session:/g) ?? []).length, 8, "all 8 session pointers must survive");
  });

  it("output stays within ceiling when children have very long reference paths", () => {
    // Max-length paths push the per-child fixed cost near the reference cap (500 chars),
    // stressing the budget computation in a way that short paths do not.
    const longArt = "/artifacts/" + "a".repeat(480) + "/out.md";
    const longSess = "/sessions/" + "b".repeat(480) + "/session.jsonl";
    const children = Array.from({ length: 8 }, (_, i) => ({
      agent: `worker-${i}`,
      status: "completed" as const,
      summary: LONG_SUMMARY,
      artifactPath: longArt,
      sessionPath: longSess,
      index: i,
    }));

    const { text } = formatForegroundNativeSubagentResult({
      runId: "run-long-refs",
      mode: "parallel",
      children,
    });

    assert.ok(text.length <= MAX_CHARS, `length ${text.length} exceeds ceiling`);
    assert.doesNotThrow(() => assertNoMangledMarker("long-refs", text));
    assert.doesNotThrow(() => assertNoOrphanedNestedHeading("long-refs", text));
    assert.ok(text.isWellFormed());
  });

  // -------------------------------------------------------------------------
  // Premature-drop guard: no child is dropped while its bare
  // scaffolding would fit.
  //
  // Before the fix the per-child fit decision included a 1-char summary-line
  // placeholder in fixedCost, making the loop think each child cost 1 char more
  // than its bare scaffolding actually does. With 8 children the overcount was
  // 8 chars, causing a premature drop whenever the true scaffold total was in
  // [7993, 8000] — a range the loop saw as [8001, 8008].
  //
  // Boundary measured with: runId="" (outerCost=85), artifactPath=425 chars,
  // sessionPath=500 chars. Per-child fixedCost (new, 8-child sum): 7909.
  // Scaffold_new = 85 + 7909 = 7994 ≤ 8000 → all 8 fit.
  // Scaffold_old = 7994 + 8 = 8002 > 8000 → premature drop to 7.
  //
  // At artifactPath=426 the new scaffold is 8002 > 8000, so the drop to 7 is
  // legitimate and expected in both old and new code.
  // -------------------------------------------------------------------------
  it("no child dropped while bare scaffolding fits", () => {
    const artPath = "a".repeat(425); // 425 chars — scaffold_new = 7994 ≤ 8000
    const sessPath = "b".repeat(500); // 500 chars (at the reference cap)
    const children = Array.from({ length: 8 }, (_, i) => ({
      agent: `worker-${i}`,
      status: (i === 0 ? "failed" : "completed") as "failed" | "completed",
      summary: LONG_SUMMARY,
      artifactPath: artPath,
      sessionPath: sessPath,
      index: i,
    }));

    const { text } = formatForegroundNativeSubagentResult({
      runId: "", // empty runId gives outerCost=85
      mode: "parallel",
      children,
    });
    const artCount = (text.match(/Output artifact:/g) ?? []).length;
    const sessCount = (text.match(/Session:/g) ?? []).length;

    // All 8 children must render: their bare scaffolding (7994 chars) fits.
    assert.equal(artCount, 8, `expected 8 artifact pointers, got ${artCount}`);
    assert.equal(sessCount, 8, `expected 8 session pointers, got ${sessCount}`);
    assert.ok(text.length <= MAX_CHARS, `length ${text.length} exceeds ceiling`);
    assert.ok(text.isWellFormed());

    // At +1 char (artifactPath=426), scaffold_new = 8002 > 8000: drop to 7 is legitimate.
    const artPlus = "a".repeat(426);
    const childrenPlus = Array.from({ length: 8 }, (_, i) => ({
      agent: `worker-${i}`,
      status: (i === 0 ? "failed" : "completed") as "failed" | "completed",
      summary: LONG_SUMMARY,
      artifactPath: artPlus,
      sessionPath: sessPath,
      index: i,
    }));
    const { text: textPlus } = formatForegroundNativeSubagentResult({
      runId: "",
      mode: "parallel",
      children: childrenPlus,
    });
    const artCountPlus = (textPlus.match(/Output artifact:/g) ?? []).length;
    // 7 of 8 is expected here (scaffold exceeds ceiling), and output must still be within bound.
    assert.equal(
      artCountPlus,
      7,
      `expected 7 artifact pointers at boundary+1, got ${artCountPlus}`,
    );
    assert.ok(textPlus.length <= MAX_CHARS, `length ${textPlus.length} exceeds ceiling`);
  });

  // -------------------------------------------------------------------------
  // Bare-heading guard: orphaned 'Summary:' heading when per-child summary budget is exhausted.
  //
  // When the per-child summary budget is smaller than any well-formed truncation
  // marker, boundedNativeForegroundSummary returns "", and the caller must NOT
  // emit the 'Summary:' heading at all — an orphaned heading is worse than none.
  //
  // Measured shape: 8 children, 7 with 500-char artifact and session paths
  // (budget too tight for any marker), 1 with no references (budget fits the
  // shorter no-references marker). Before the fix: 7 bare 'Summary:' headings.
  // After the fix: 0 bare 'Summary:' headings.
  //
  // Detector note: the previous search for this defect only treated a heading as
  // bare when the next line was a child header or end of input, missing the case
  // where scaffolding lines (e.g. 'Output artifact:') follow. The correct detector
  // below treats a 'Summary:' heading as bare when its next non-blank line is
  // scaffolding, an omission marker, or end of input.
  // -------------------------------------------------------------------------
  it("no bare 'Summary:' heading emitted when per-child summary budget is exhausted", () => {
    // 7 children carry 500-char paths that push the per-child budget below any
    // well-formed marker length; 1 child has no references and receives the shorter
    // (49-char) no-references marker which still fits.
    const fatArtPath = "a".repeat(500);
    const fatSessPath = "b".repeat(500);
    const children = Array.from({ length: 8 }, (_, i) => ({
      agent: `worker-${i}`,
      status: "completed" as const,
      summary: "S".repeat(1_200),
      // 7 children with 500-char paths; last child has no references.
      ...(i < 7 ? { artifactPath: fatArtPath, sessionPath: fatSessPath } : {}),
      index: i,
    }));

    const { text } = formatForegroundNativeSubagentResult({
      runId: "run-finding-a-regression",
      mode: "parallel",
      children,
    });

    // All 8 children must still be displayed and output must be within ceiling.
    assert.ok(text.length <= MAX_CHARS, `length ${text.length} exceeds ceiling`);
    assert.equal((text.match(/worker-/g) ?? []).length, 8, "all 8 children must appear");

    // Count bare 'Summary:' headings using the correct detector:
    // a heading is bare when its next non-blank line is scaffolding,
    // an omission marker, or end of input — NOT only when a child header follows.
    const lines = text.split("\n");
    let bareSummaryCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.trim() !== "Summary:") continue;
      let j = i + 1;
      while (j < lines.length && lines[j]?.trim() === "") j++;
      const next = lines[j]?.trim() ?? "";
      // Scaffolding lines that would directly follow an orphaned heading:
      const isScaffolding =
        next.startsWith("Output artifact:") ||
        next.startsWith("Session:") ||
        next.startsWith("Nested subagents:");
      const isOmissionMarker = next.startsWith("…");
      const isChildHeader = /^\d+\/\d+\./.test(next); // e.g. '2/8. worker'
      const isEndOfInput = j >= lines.length;
      if (isScaffolding || isOmissionMarker || isEndOfInput || isChildHeader) bareSummaryCount++;
    }
    // Before the fix: 7 bare headings. After the fix: 0.
    assert.equal(
      bareSummaryCount,
      0,
      `${bareSummaryCount} bare 'Summary:' heading(s) found; expected 0`,
    );

    // Additional gate checks from the contract sweep.
    assert.doesNotThrow(() => assertNoMangledMarker("finding-a", text));
    assert.doesNotThrow(() => assertNoOrphanedNestedHeading("finding-a", text));
    assert.ok(text.isWellFormed());
  });

  // -------------------------------------------------------------------------
  // Omission-marker guard: marker must not direct reader to paths of retained children.
  //
  // When some (not all) children are dropped for size, the omitted children's
  // paths are never emitted. The marker must not imply those results are
  // reachable through paths that belong to retained children.
  //
  // Measured shape: 8 children at 499-char paths; 7 display, 1 is dropped.
  // Before the fix: marker said "see listed paths above" (misdirected).
  // After the fix: marker states output is not reachable from this envelope.
  // -------------------------------------------------------------------------
  it("partial-drop omission marker does not point at retained children's paths", () => {
    // 499-char paths push the fixed cost just over the ceiling at 8 children,
    // causing exactly 1 child to be dropped.
    const artPath = "a".repeat(499);
    const sessPath = "b".repeat(499);
    const children = Array.from({ length: 8 }, (_, i) => ({
      agent: `worker-${i}`,
      status: "completed" as const,
      summary: "S".repeat(1_200),
      artifactPath: artPath,
      sessionPath: sessPath,
      index: i,
    }));

    const { text } = formatForegroundNativeSubagentResult({
      runId: "run-finding-b-regression",
      mode: "parallel",
      children,
    });

    // 7 children retained, 1 dropped — confirm the partial-drop case fired.
    const artCount = (text.match(/Output artifact:/g) ?? []).length;
    assert.equal(artCount, 7, `expected 7 retained artifact pointers, got ${artCount}`);

    // The omission marker must not claim the dropped child's output is reachable
    // through the retained children's paths.
    assert.doesNotMatch(
      text,
      /see listed paths above/,
      "marker must not direct reader to paths belonging to retained children",
    );
    // The marker must include the count and state that output is not reachable.
    assert.match(
      text,
      /… \[1 additional child results omitted; their output is not reachable from this envelope\]/,
      "marker must state omitted output is not reachable from this envelope",
    );

    // Ceiling and well-formedness.
    assert.ok(text.length <= MAX_CHARS, `length ${text.length} exceeds ceiling`);
    assert.doesNotThrow(() => assertNoMangledMarker("finding-b", text));
    assert.ok(text.isWellFormed());
  });
});
