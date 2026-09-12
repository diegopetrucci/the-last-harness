import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  MAX_COMPLETION_MESSAGE_CHARS,
  MAX_DISPLAY_SUMMARY_CHARS,
  buildCompletionDetails,
  formatGroupedCompletion,
  formatSingleCompletion,
  type SubagentNotifyDetails,
} from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { createBatchingPi, createFakeClock, createPi } from "../support/notify-fixtures.ts";

describe("completion formatting helpers", () => {
  it("formatSingleCompletion mirrors the in-handler single message shape", () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-format-session-"));
    const sessionFile = path.join(resultsDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "session\n", "utf-8");
    try {
      const content = formatSingleCompletion({
        agent: "worker",
        status: "completed",
        taskInfo: " (2/3)",
        resultPreview: "Done",
        asyncId: "notify-1",
        resumeTarget: { sessionPath: sessionFile },
        sessionLabel: "Session file",
        sessionValue: sessionFile,
      });
      assert.equal(
        content,
        `Background task completed: **worker** (2/3)\n\nAsync id: notify-1\nRevive: subagent({ action: "resume", id: "notify-1", message: "..." })\n\nDone\n\nSession file: ${sessionFile}`,
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("retains normalized single and multi-child share URLs while suppressing only duplicate top-level session files", () => {
    const sessionFile = "/sessions/worker.jsonl";
    const single = buildCompletionDetails({
      id: "shared-single",
      agent: "worker",
      success: true,
      summary: "done",
      timestamp: 1,
      shareUrl: "https://share/single",
      shareError: "must lose to shareUrl",
      sessionFile,
      results: [
        { agent: "worker", status: "completed", summary: "done", sessionPath: sessionFile },
      ],
    });
    assert.equal(single.sessionLabel, "Session");
    assert.equal(single.sessionValue, "https://share/single");
    const singleContent = formatSingleCompletion(single);
    assert.match(singleContent, /Session: https:\/\/share\/single$/);
    assert.equal(
      singleContent.split(sessionFile).length - 1,
      1,
      "the child reference must not be duplicated as a top-level session file",
    );
    assert.doesNotMatch(singleContent, /Session file:/);
    assert.doesNotMatch(singleContent, /must lose to shareUrl/);

    const multi = buildCompletionDetails({
      id: "shared-multi",
      agent: "parallel:a+b",
      success: true,
      summary: "done",
      timestamp: 1,
      shareUrl: "https://share/multi",
      sessionFile: "/sessions/top-level.jsonl",
      results: [
        { agent: "a", status: "completed", summary: "a done" },
        { agent: "b", status: "completed", summary: "b done" },
      ],
    });
    assert.equal(multi.sessionLabel, "Session");
    assert.equal(multi.sessionValue, "https://share/multi");
    assert.match(formatSingleCompletion(multi), /Session: https:\/\/share\/multi$/);

    const unshared = buildCompletionDetails({
      id: "unshared-single",
      agent: "worker",
      success: true,
      summary: "done",
      timestamp: 1,
      sessionFile,
      results: [
        { agent: "worker", status: "completed", summary: "done", sessionPath: sessionFile },
      ],
    });
    assert.equal(unshared.sessionValue, undefined);
    const unsharedContent = formatSingleCompletion(unshared);
    assert.equal(unsharedContent.split(sessionFile).length - 1, 1);
    assert.doesNotMatch(unsharedContent, /Session file:/);
  });

  it("formatGroupedCompletion lists each agent with its summary and session", () => {
    const content = formatGroupedCompletion([
      { agent: "alpha", status: "completed", resultPreview: "alpha done", asyncId: "alpha-id" },
      {
        agent: "beta",
        status: "completed",
        taskInfo: " (1/2)",
        resultPreview: "",
        asyncId: "beta-id",
        sessionLabel: "Session",
        sessionValue: "https://share/abc",
      },
    ]);
    assert.equal(
      content,
      "Background tasks completed (2): **alpha**, **beta** (1/2)\n\n" +
        "1. alpha\nAsync id: alpha-id\nalpha done\n\n" +
        "2. beta (1/2)\nAsync id: beta-id\n(no output)\nSession: https://share/abc",
    );
  });

  it("validates bounded async ids and safely quotes resumable commands", () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-safe-id-"));
    const sessionFile = path.join(resultsDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "session\n", "utf-8");
    try {
      const quotedId = 'notify-"quoted';
      const quotedDetails = buildCompletionDetails({
        id: quotedId,
        runId: "unused-run-id",
        agent: "worker",
        success: true,
        summary: "done",
        timestamp: 1,
        sessionFile,
      });
      const quotedContent = formatSingleCompletion(quotedDetails);
      assert.equal(quotedDetails.asyncId, quotedId);
      assert.ok(quotedContent.includes(`id: ${JSON.stringify(quotedId)}`));

      const whitespaceId = "  spaced-id  ";
      const whitespaceDetails = buildCompletionDetails({
        id: whitespaceId,
        runId: "unused-whitespace-fallback",
        agent: "worker",
        success: true,
        summary: "done",
        timestamp: 1,
        sessionFile,
      });
      assert.equal(whitespaceDetails.asyncId, whitespaceId);
      assert.ok(
        formatSingleCompletion(whitespaceDetails).includes(`id: ${JSON.stringify(whitespaceId)}`),
      );

      for (const rejectedId of ["/tmp/run", "folder/run", "folder\\run", "run..suffix", "   "]) {
        const fallbackDetails = buildCompletionDetails({
          id: rejectedId,
          runId: "resolver-valid-fallback",
          agent: "worker",
          success: true,
          summary: "done",
          timestamp: 1,
          sessionFile,
        });
        assert.equal(fallbackDetails.asyncId, "resolver-valid-fallback");
        const fallbackContent = formatSingleCompletion(fallbackDetails);
        assert.ok(fallbackContent.includes('id: "resolver-valid-fallback"'));
        assert.equal(fallbackContent.includes(`id: ${JSON.stringify(rejectedId)}`), false);
      }

      assert.equal(
        buildCompletionDetails({
          id: "x".repeat(201),
          runId: "bounded-fallback",
          agent: "worker",
          success: true,
          summary: "done",
          timestamp: 1,
        }).asyncId,
        "bounded-fallback",
      );
      assert.equal(
        buildCompletionDetails({
          id: "malformed\nid",
          runId: "safe-fallback",
          agent: "worker",
          success: true,
          summary: "done",
          timestamp: 1,
        }).asyncId,
        "safe-fallback",
      );
      assert.equal(
        buildCompletionDetails({
          id: "x".repeat(201),
          runId: "y".repeat(201),
          agent: "worker",
          success: true,
          summary: "done",
          timestamp: 1,
        }).asyncId,
        undefined,
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("omits resume guidance for invalid normalized child indexes", () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-invalid-index-"));
    const sessionFile = path.join(resultsDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "session\n", "utf-8");
    try {
      for (const index of [-1, 2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const details = buildCompletionDetails({
          id: "invalid-index-run",
          agent: "parallel:a+b",
          success: true,
          summary: "done",
          timestamp: 1,
          results: [
            { agent: "a", status: "completed", summary: "a", index, sessionPath: sessionFile },
            { agent: "b", status: "completed", summary: "b" },
          ],
        });
        assert.equal(details.resumeTarget, undefined);
        assert.doesNotMatch(formatSingleCompletion(details), /subagent\({ action: "resume"/);
      }
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("prefers the paused child resume target when normalized results preserve the original interrupted index", () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-paused-resume-index-"));
    const pausedSessionFile = path.join(resultsDir, "paused-session.jsonl");
    fs.writeFileSync(pausedSessionFile, "session\n", "utf-8");
    try {
      const details = buildCompletionDetails({
        id: "paused-index-run",
        agent: "chain:a+b",
        success: false,
        state: "paused",
        summary: "Paused after interrupt.",
        timestamp: 1,
        results: [
          { agent: "a", status: "completed", summary: "done", index: 0 },
          { agent: "b", status: "completed", summary: "done", index: 1 },
          { agent: "c", status: "completed", summary: "done", index: 2 },
          { agent: "d", status: "completed", summary: "done", index: 3 },
          {
            agent: "e",
            status: "paused",
            summary: "Paused after interrupt.",
            index: 4,
            sessionPath: pausedSessionFile,
          },
        ],
      });
      assert.deepEqual(details.resumeTarget, {
        sessionPath: pausedSessionFile,
        index: 4,
        childCount: 5,
      });
      assert.match(
        formatSingleCompletion(details),
        /Revive child: subagent\({ action: "resume", id: "paused-index-run", index: 4, message: "\.\.\." }\)/,
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("buildCompletionDetails derives paused status from state and summary", () => {
    assert.equal(
      buildCompletionDetails({
        id: "x",
        agent: "w",
        success: false,
        state: "paused",
        summary: "Paused after interrupt.",
        timestamp: 1,
      }).status,
      "paused",
    );
    assert.equal(
      buildCompletionDetails({
        id: "x",
        agent: "w",
        success: false,
        summary: "boom",
        exitCode: 1,
        timestamp: 1,
      }).status,
      "failed",
    );
    assert.equal(
      buildCompletionDetails({
        id: "x",
        agent: "w",
        success: true,
        summary: "ok",
        exitCode: 0,
        timestamp: 1,
      }).status,
      "completed",
    );
  });

  it("buildCompletionDetails prioritizes child failure, outer failure, pause, and completion", () => {
    const base = {
      id: "grouped",
      agent: "parallel",
      success: true,
      summary: "outer",
      timestamp: 1,
    };
    assert.equal(
      buildCompletionDetails({
        ...base,
        results: [
          { agent: "a", status: "paused", summary: "paused" },
          { agent: "b", status: "failed", summary: "failed" },
        ],
      }).status,
      "failed",
    );
    assert.equal(
      buildCompletionDetails({
        ...base,
        success: false,
        state: "failed",
        results: [
          { agent: "a", status: "completed", summary: "done" },
          { agent: "b", status: "paused", summary: "paused" },
        ],
      }).status,
      "failed",
    );
    assert.equal(
      buildCompletionDetails({
        ...base,
        success: false,
        state: "paused",
        results: [
          { agent: "a", status: "completed", summary: "done" },
          { agent: "b", status: "completed", summary: "done" },
        ],
      }).status,
      "paused",
    );
    assert.equal(
      buildCompletionDetails({
        ...base,
        results: [
          { agent: "a", status: "completed", summary: "done" },
          { agent: "b", status: "paused", summary: "paused" },
        ],
      }).status,
      "paused",
    );
  });

  it("prepends a bounded unrepresented outer failure while preserving a paused child resume target", () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-outer-failure-paused-child-"));
    const pausedSessionFile = path.join(resultsDir, "paused-session.jsonl");
    fs.writeFileSync(pausedSessionFile, "session\n", "utf-8");
    try {
      // Use a summary longer than MAX_SUMMARY_CHARS (8 000 chars) to verify
      // that the outer failure is still bounded at the per-child budget.
      const outerCrash = `runner crashed: ${"x".repeat(8_100)}`;
      const details = buildCompletionDetails({
        id: "outer-failed-paused-child",
        agent: "chain:a+b",
        success: false,
        state: "failed",
        summary: outerCrash,
        timestamp: 1,
        results: [
          { agent: "a", status: "completed", summary: "a done", index: 0 },
          {
            agent: "b",
            status: "paused",
            summary: "Paused after interrupt.",
            index: 1,
            sessionPath: pausedSessionFile,
          },
        ],
      });

      assert.equal(details.status, "failed");
      assert.deepEqual(details.resumeTarget, {
        sessionPath: pausedSessionFile,
        index: 1,
        childCount: 2,
      });
      assert.match(details.resultPreview, /^runner crashed: x+/);
      // Summary exceeds MAX_SUMMARY_CHARS so it should be truncated with the
      // marker, followed immediately by the children section.
      assert.match(
        details.resultPreview,
        /… \[summary truncated\]\n\nChildren: 1 completed, 1 paused/,
      );
      assert.match(
        formatSingleCompletion(details),
        /Revive child: subagent\({ action: "resume", id: "outer-failed-paused-child", index: 1, message: "\.\.\." }\)/,
      );

      const singleChildDiagnostic = "runner exited after its child completed";
      const singleChild = buildCompletionDetails({
        id: "outer-failed-single-empty-child",
        agent: "single-worker",
        success: false,
        state: "failed",
        summary: singleChildDiagnostic,
        timestamp: 1,
        results: [{ agent: "single-worker", status: "completed" }],
      });
      assert.equal(singleChild.resultPreview, `${singleChildDiagnostic}\n\n(no output)`);
      assert.equal(singleChild.resultPreview.split(singleChildDiagnostic).length - 1, 1);

      const represented = buildCompletionDetails({
        id: "represented-outer-failure",
        agent: "parallel:a+b",
        success: false,
        state: "failed",
        summary: "outer diagnostic must not duplicate a failed child",
        timestamp: 1,
        results: [
          { agent: "a", status: "failed", summary: "child failure represents the run" },
          { agent: "b", status: "completed", summary: "done" },
        ],
      });
      assert.doesNotMatch(represented.resultPreview, /outer diagnostic/);
      assert.match(represented.resultPreview, /^Children: 1 completed, 1 failed/);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("buildCompletionDetails falls back to the unknown agent label", () => {
    const details: SubagentNotifyDetails = buildCompletionDetails({
      id: "x",
      agent: null,
      success: true,
      summary: "ok",
      timestamp: 1,
    });
    assert.equal(details.agent, "unknown");
    assert.equal(details.status, "completed");
  });

  it("single-result notice carries summary up to the single-result budget and still respects the envelope", () => {
    // A summary between MAX_DISPLAY_SUMMARY_CHARS (1 200) and MAX_SUMMARY_CHARS
    // (8,000) must reach the model in full via content while structuredDetails.resultPreview
    // is still capped at MAX_DISPLAY_SUMMARY_CHARS for the TUI.
    const { events, sentMessages } = createPi();
    const longSummary = `rich result: ${"r".repeat(4_000)}`;

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "budget-single-1",
      agent: "worker",
      success: true,
      summary: longSummary,
      exitCode: 0,
      timestamp: 1,
      sessionId: "session-1",
    });

    assert.equal(sentMessages.length, 1);
    const message = sentMessages[0]!.message as {
      content: string;
      details?: SubagentNotifyDetails;
    };
    // content carries the full summary (no truncation — well under MAX_COMPLETION_MESSAGE_CHARS)
    assert.ok(
      message.content.includes(longSummary),
      "model-facing content must carry the full summary beyond the old 1 200-char cap",
    );
    assert.ok(message.content.length <= MAX_COMPLETION_MESSAGE_CHARS);
    // structuredDetails.resultPreview is bounded at MAX_DISPLAY_SUMMARY_CHARS for the TUI
    assert.ok(message.details, "single notice must include structuredDetails");
    assert.ok(
      message.details!.resultPreview.length <= MAX_DISPLAY_SUMMARY_CHARS,
      "TUI details.resultPreview must be bounded at MAX_DISPLAY_SUMMARY_CHARS",
    );
    assert.ok(
      !message.content.includes("… [summary truncated]"),
      "a summary within the single-result budget must not be truncated in content",
    );
  });

  it("grouped notice gives each displayed child the full per-child budget so both summaries arrive untruncated", () => {
    // Two children each with a summary between MAX_DISPLAY_SUMMARY_CHARS (1 200) and the
    // per-child budget (MAX_SUMMARY_CHARS = 8 000 at this fan-out). Both appear untruncated,
    // proving each child gets the full per-child budget rather than a divided share.
    const { events, sentMessages } = createPi();
    const summaryA = `child-a result: ${"a".repeat(2_000)}`;
    const summaryB = `child-b result: ${"b".repeat(2_000)}`;

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "budget-grouped-1",
      agent: "parallel:a+b",
      success: true,
      summary: "outer done",
      timestamp: 1,
      sessionId: "session-1",
      results: [
        { agent: "a", status: "completed", summary: summaryA, index: 0 },
        { agent: "b", status: "completed", summary: summaryB, index: 1 },
      ],
    });

    assert.equal(sentMessages.length, 1);
    const message = sentMessages[0]!.message as { content: string };
    assert.ok(
      message.content.includes(summaryA),
      "grouped content must carry child-a summary beyond the old 1 200-char cap",
    );
    assert.ok(
      message.content.includes(summaryB),
      "grouped content must carry child-b summary beyond the old 1 200-char cap",
    );
    assert.ok(message.content.length <= MAX_COMPLETION_MESSAGE_CHARS);
    assert.ok(
      !message.content.includes("… [summary truncated]"),
      "child summaries within the per-child budget must not be truncated in content",
    );
  });

  // Regression guard for the grouped budget shape. Each displayed child gets the full
  // per-child MAX_SUMMARY_CHARS budget; a child's report must not shrink merely because
  // it has siblings. The trailing `Session:` recovery pointer must survive in every case,
  // because formatSingleCompletion emits it LAST and a naive end-cut would destroy it,
  // turning a "truncated but recoverable" notice into a "truncated and unrecoverable" one.
  for (const childCount of [2, 8]) {
    it(`grouped notice with ${childCount} children filling their budget keeps the recovery pointer inside the ceiling`, () => {
      const { events, sentMessages } = createPi();
      const shareUrl = `https://share/grouped-capacity-${childCount}`;
      // Oversized summaries so boundedSummary clamps each child to EXACTLY the per-child
      // budget. This fills the budget to capacity without the test needing to know the
      // constant's value. Child artifact/session references are populated too, since those
      // are real scaffolding that competes for the same ceiling.
      const results = Array.from({ length: childCount }, (_, index) => ({
        agent: `worker-${index}`,
        status: "completed",
        summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
        index,
        artifactPath: `/tmp/artifacts/worker-${index}.md`,
        sessionPath: `/tmp/sessions/worker-${index}.jsonl`,
      }));

      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: `grouped-capacity-${childCount}`,
        agent: "parallel:capacity",
        success: true,
        summary: "outer done",
        timestamp: 1,
        sessionId: "session-1",
        shareUrl,
        results,
      });

      assert.equal(sentMessages.length, 1);
      const content = (sentMessages[0]!.message as { content: string }).content;

      // 1. The assembled message must fit the ceiling.
      assert.ok(
        content.length <= MAX_COMPLETION_MESSAGE_CHARS,
        `assembled grouped message (${content.length}) must fit MAX_COMPLETION_MESSAGE_CHARS`,
      );

      // 2. The trailing recovery pointer must survive. This is the assertion with teeth.
      assert.ok(
        content.includes(`Session: ${shareUrl}`),
        "the trailing Session line must survive; a naive end-cut would truncate the recovery pointer away",
      );
    });
  }

  // Direct regression test for tail-preserving truncation. Deliberately forces an overflow
  // PAST the ceiling (8 children at full per-child budget plus long reference lines), which
  // the per-child budget alone cannot prevent: at n=8 the equal-share fallback already
  // allocates 8 x 4 000 = 32 000 chars of summary, exactly the ceiling, leaving nothing for
  // scaffolding. The assembled message therefore MUST be clamped, and the clamp must cut
  // from the preview body rather than from the tail, so the trailing Session line and the
  // child artifact references both survive. Without tail preservation the final
  // truncateWithMarker cuts from the end and destroys exactly those recovery pointers.
  it("clamps an over-ceiling notice while preserving the trailing session line and child references", () => {
    const { events, sentMessages } = createPi();
    const shareUrl = "https://share/tail-preservation-overflow";
    // Long reference lines on every child, pushing well past the ceiling once the 8 full
    // per-child summaries are laid down.
    const results = Array.from({ length: 8 }, (_, index) => ({
      agent: `worker-${index}`,
      // Urgency ordering puts the failed child first, so its references sit at the front.
      status: index === 0 ? "failed" : "completed",
      summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
      index,
      artifactPath: `/tmp/artifacts/${"deep-path-segment/".repeat(10)}worker-${index}.md`,
      sessionPath: `/tmp/sessions/${"deep-path-segment/".repeat(10)}worker-${index}.jsonl`,
    }));

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "tail-preservation-overflow",
      agent: "parallel:overflow",
      success: true,
      summary: "outer done",
      timestamp: 1,
      sessionId: "session-1",
      shareUrl,
      results,
    });

    assert.equal(sentMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;

    // 1. Clamped to the ceiling.
    assert.ok(
      content.length <= MAX_COMPLETION_MESSAGE_CHARS,
      `over-ceiling message (${content.length}) must be clamped to MAX_COMPLETION_MESSAGE_CHARS`,
    );

    // 2. The trailing recovery pointer survives the clamp. This is the assertion with teeth:
    // a naive end-cut removes it, because it is the very last line of the assembled message.
    assert.ok(
      content.includes(`Session: ${shareUrl}`),
      "tail-preserving truncation must keep the trailing Session line even when the ceiling is hit",
    );

    // 3. Child artifact references survive for the urgent (first-displayed) child, so the
    // architect retains a pointer to the full output of the result that matters most.
    assert.ok(
      content.includes("worker-0.md"),
      "the urgent child's artifact reference must survive the clamp",
    );
    assert.ok(
      content.includes("worker-0.jsonl"),
      "the urgent child's session reference must survive the clamp",
    );
  });

  // -------------------------------------------------------------------------
  // Defect 1 regression: formatGroupedCompletion ceiling-overshoot fix.
  //
  // These tests call formatGroupedCompletion directly with MULTIPLE
  // SubagentNotifyDetails entries (the batched path). The earlier tests at
  // ~1568 emit ONE SubagentResult with children, which routes through
  // formatSingleCompletion/buildCompletionDetails and never hits this path.
  //
  // Each entry is "saturated" — its resultPreview is longer than previewCeiling,
  // so it fills every available char. The fix adds the per-entry \n separator
  // cost (entries.length - 2) to the budget reservation so the assembled string
  // is always exactly <= MAX_COMPLETION_MESSAGE_CHARS.
  // -------------------------------------------------------------------------
  for (const entryCount of [2, 3, 4, 8, 16, 40]) {
    it(`formatGroupedCompletion with ${entryCount} saturated entries stays within the ceiling and preserves all session pointers`, () => {
      // Each detail has a session pointer (worst-case scaffolding), and a resultPreview
      // much larger than any possible previewCeiling so it saturates the budget exactly.
      const details: SubagentNotifyDetails[] = Array.from({ length: entryCount }, (_, i) => ({
        agent: `worker-${i}`,
        status: "completed" as const,
        resultPreview: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
        sessionLabel: "Session",
        sessionValue: `https://share/worker-${i}`,
      }));
      const result = formatGroupedCompletion(details);

      // 1. Assembled string must fit the ceiling.
      assert.ok(
        result.length <= MAX_COMPLETION_MESSAGE_CHARS,
        `formatGroupedCompletion(${entryCount}) produced ${result.length} chars, exceeding MAX_COMPLETION_MESSAGE_CHARS`,
      );

      // 2. Every DISPLAYED entry's session pointer must survive.
      // Entries beyond MAX_GROUPED_ENTRIES=8 are omitted, so only check those shown.
      const displayedCount = Math.min(entryCount, 8);
      for (let i = 0; i < displayedCount; i++) {
        assert.ok(
          result.includes(`Session: https://share/worker-${i}`),
          `session pointer for displayed entry ${i} missing from grouped output at n=${entryCount}`,
        );
      }
    });
  }

  it("formatGroupedCompletion caps displayed entries at 8 and emits an omission marker for the rest", () => {
    // Defect 2: batch size was unbounded. Verify the cap is applied and the omission
    // marker uses the same wording as existing child-result omission notices.
    const details: SubagentNotifyDetails[] = Array.from({ length: 12 }, (_, i) => ({
      agent: `worker-${i}`,
      status: "completed" as const,
      resultPreview: "done",
      sessionLabel: "Session",
      sessionValue: `https://share/worker-${i}`,
    }));
    const result = formatGroupedCompletion(details);

    // Ceiling holds.
    assert.ok(result.length <= MAX_COMPLETION_MESSAGE_CHARS);

    // The total count in the header shows all 12.
    assert.ok(result.includes("Background tasks completed (12):"), "header must show total count");

    // First 8 displayed.
    assert.ok(result.includes("Session: https://share/worker-0"), "first entry must be shown");
    assert.ok(result.includes("Session: https://share/worker-7"), "eighth entry must be shown");

    // Entries 9-12 are omitted.
    assert.ok(!result.includes("Session: https://share/worker-8"), "ninth entry must be omitted");
    assert.ok(
      result.includes("[4 entries omitted]"),
      "omission marker must appear for the 4 dropped entries",
    );
  });

  it("batched send-time path routes multiple completions through formatGroupedCompletion and respects the ceiling", () => {
    // End-to-end test: MULTIPLE SubagentResult events batch together and are
    // emitted as one grouped message. This exercises the send-time cap on top
    // of the per-entry budget fix.
    const clock = createFakeClock();
    const { events, sentMessages } = createBatchingPi(clock);

    // Emit 4 separate completions with saturated summaries. The batcher holds
    // them and emits as one group when the debounce fires.
    for (let i = 0; i < 4; i++) {
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: `batched-ceiling-${i}`,
        agent: `parallel-worker-${i}`,
        success: true,
        summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
        timestamp: 1,
        sessionId: "session-a",
        shareUrl: `https://share/batched-${i}`,
      });
    }
    // Advance past debounce to trigger grouped emit.
    clock.advance(200);

    assert.equal(
      sentMessages.length,
      1,
      "4 batched completions must produce exactly 1 grouped message",
    );
    const content = (sentMessages[0]!.message as { content: string }).content;

    // 1. The grouped message fits the ceiling.
    assert.ok(
      content.length <= MAX_COMPLETION_MESSAGE_CHARS,
      `batched grouped message (${content.length}) must fit MAX_COMPLETION_MESSAGE_CHARS`,
    );

    // 2. Each entry's session pointer survives (they are the last line of each block).
    for (let i = 0; i < 4; i++) {
      assert.ok(
        content.includes(`Session: https://share/batched-${i}`),
        `session pointer for worker-${i} must survive the send-time ceiling in the batched path`,
      );
    }
  });

  // =========================================================================
  // Bug-species regression: per-child scaffolding reservation fixes
  //
  // These three groups test the three occurrences of the same bug: a budget
  // divided up to the ceiling without reserving the fixed recovery scaffolding
  // (per-child labels, Output artifact: and Session: lines) that must travel
  // with the allocated content. In all three shapes, EVERY displayed child must
  // retain BOTH reference lines even when summaries are saturated.
  // =========================================================================

  // --- Occurrence 1: resolvePerChildSummaryBudget equality defect ---
  // Prior to the fix, count * MAX_SUMMARY_CHARS === MAX_COMPLETION_MESSAGE_CHARS
  // returned the full 8 000 per child, leaving zero for labels, reference lines,
  // blank separators, and outer scaffolding. n=4 was the exact equality case;
  // n=5 and n=8 triggered the equal-share fallback which also failed to reserve
  // the per-child non-summary cost. All three pinned at exactly 32 000 chars
  // with the last child's reference pair missing.
  for (const childCount of [2, 4, 5, 8]) {
    it(`every displayed child retains BOTH reference lines at n=${childCount} when the per-child budget exactly consumes the ceiling`, () => {
      const { events, sentMessages } = createPi();
      const shareUrl = `https://share/per-child-refs-${childCount}`;
      const results = Array.from({ length: childCount }, (_, index) => ({
        agent: `worker-${index}`,
        status: "completed",
        // Saturate each child's summary budget so the per-child budget is the
        // binding constraint and reference lines are at maximum risk.
        summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
        index,
        artifactPath: `/tmp/artifacts/worker-${index}.md`,
        sessionPath: `/tmp/sessions/worker-${index}.jsonl`,
      }));

      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: `per-child-refs-${childCount}`,
        agent: "parallel",
        success: true,
        summary: "outer done",
        timestamp: 1,
        sessionId: "session-1",
        shareUrl,
        results,
      });

      assert.equal(sentMessages.length, 1);
      const content = (sentMessages[0]!.message as { content: string }).content;

      // 1. Message must fit the ceiling.
      assert.ok(
        content.length <= MAX_COMPLETION_MESSAGE_CHARS,
        `assembled message (${content.length}) must fit MAX_COMPLETION_MESSAGE_CHARS at n=${childCount}`,
      );

      // 2. EVERY displayed child must retain BOTH reference lines.
      // This is the assertion the prior test suite lacked — it only checked the
      // outer Session line, missing the per-child references entirely.
      const displayedCount = Math.min(childCount, 8);
      for (let i = 0; i < displayedCount; i++) {
        assert.ok(
          content.includes(`Output artifact: /tmp/artifacts/worker-${i}.md`),
          `child ${i} artifact reference must survive at n=${childCount}`,
        );
        assert.ok(
          content.includes(`Session: /tmp/sessions/worker-${i}.jsonl`),
          `child ${i} session reference must survive at n=${childCount}`,
        );
      }

      // 3. Outer session recovery pointer also survives.
      assert.ok(content.includes(`Session: ${shareUrl}`), "outer session pointer must survive");
    });
  }

  // --- Occurrence 2: outer failure summary excluded from allocation ---
  // When the outer result failed (but no child is individually failed) the
  // outer failure summary consumed up to MAX_SUMMARY_CHARS chars that were not
  // subtracted from the ceiling before dividing among children. Three saturated
  // children with an 8 000-char outer failure summary totalled 32 000 before
  // labels and reference lines, pinning at exactly 32 000 with child 2's
  // references missing. The fix includes the outer failure summary in the
  // non-summary-cost reservation before dividing.
  it("outer failure summary with three saturated children retains all reference lines when the outer summary is excluded from allocation", () => {
    const { events, sentMessages } = createPi();
    const shareUrl = "https://share/outer-failure-3children";

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "outer-failure-3ch",
      agent: "parallel",
      success: false,
      // Outer failure summary saturated at MAX_COMPLETION_MESSAGE_CHARS.
      summary: "f".repeat(MAX_COMPLETION_MESSAGE_CHARS),
      timestamp: 1,
      sessionId: "session-1",
      shareUrl,
      results: Array.from({ length: 3 }, (_, index) => ({
        agent: `worker-${index}`,
        // Children all completed — keeps outer as the only failure, triggering
        // the outerFailureSummary path.
        status: "completed",
        summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
        index,
        artifactPath: `/tmp/artifacts/worker-${index}.md`,
        sessionPath: `/tmp/sessions/worker-${index}.jsonl`,
      })),
    });

    assert.equal(sentMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;

    // 1. Message must fit the ceiling.
    assert.ok(
      content.length <= MAX_COMPLETION_MESSAGE_CHARS,
      `assembled message (${content.length}) must fit MAX_COMPLETION_MESSAGE_CHARS`,
    );

    // 2. All three children must retain BOTH reference lines despite the outer
    // failure summary consuming a large share of the envelope.
    for (let i = 0; i < 3; i++) {
      assert.ok(
        content.includes(`Output artifact: /tmp/artifacts/worker-${i}.md`),
        `child ${i} artifact reference must survive with saturated outer failure summary`,
      );
      assert.ok(
        content.includes(`Session: /tmp/sessions/worker-${i}.jsonl`),
        `child ${i} session reference must survive with saturated outer failure summary`,
      );
    }

    // 3. Outer recovery pointer also survives.
    assert.ok(content.includes(`Session: ${shareUrl}`), "outer session pointer must survive");
  });

  // --- Occurrence 3: nested preview inside a grouped batch ---
  // When a multi-child result is batched together with other completions, its
  // resultPreview (formatted for the single-result ceiling) can exceed the
  // per-entry previewCeiling in the grouped message. The prior code treated the
  // entire resultPreview as truncatable prose, so fitPreviewWithinCeiling cut
  // from the end — exactly where the last children's reference lines live.
  // The fix uses _reformatPreview to re-format the preview for the grouped
  // entry's ceiling, reserving non-summary scaffold before dividing.
  it("four-child normalized preview batched beside a saturated completion retains all inner child reference lines when recovery lines are nested inside a batched entry preview", () => {
    // Build the details objects directly via buildCompletionDetails so _reformatPreview is wired up.
    // Entry 1: four-child result with no shareUrl (no outer session in tailLines,
    // worst case: inner child references carry the full recovery burden).
    const details1 = buildCompletionDetails({
      id: "inner-4child-grouped",
      runId: null,
      agent: "parallel-inner",
      success: true,
      summary: "done",
      timestamp: 1,
      results: Array.from({ length: 4 }, (_, index) => ({
        agent: `worker-${index}`,
        status: "completed" as const,
        summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
        index,
        artifactPath: `/tmp/artifacts/worker-${index}.md`,
        sessionPath: `/tmp/sessions/worker-${index}.jsonl`,
      })),
    });
    const details2 = buildCompletionDetails({
      id: "saturated-single-grouped",
      runId: null,
      agent: "single-worker",
      success: true,
      summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
      timestamp: 1,
      shareUrl: "https://share/outer-single",
    });

    const result = formatGroupedCompletion([details1, details2]);

    // 1. Assembled grouped message must fit the ceiling.
    assert.ok(
      result.length <= MAX_COMPLETION_MESSAGE_CHARS,
      `grouped message (${result.length}) must fit MAX_COMPLETION_MESSAGE_CHARS`,
    );

    // 2. ALL four inner children must retain BOTH reference lines. Before the fix,
    // fitPreviewWithinCeiling cut from the end of the resultPreview, destroying the
    // third and fourth children's artifact and session lines.
    for (let i = 0; i < 4; i++) {
      assert.ok(
        result.includes(`Output artifact: /tmp/artifacts/worker-${i}.md`),
        `inner child ${i} artifact reference must survive in grouped context`,
      );
      assert.ok(
        result.includes(`Session: /tmp/sessions/worker-${i}.jsonl`),
        `inner child ${i} session reference must survive in grouped context`,
      );
    }

    // 3. The outer session pointer for the second entry also survives.
    assert.ok(
      result.includes("Session: https://share/outer-single"),
      "outer session pointer for the second entry must survive",
    );
  });

  // =========================================================================
  // formatResultPreview ceiling-contract sweep.
  //
  // formatResultPreview MUST return a string whose length is <= the supplied
  // ceilingForPreview for EVERY (shape, ceiling) combination listed here.
  // This sweep is the durable guard that prevents future changes from silently
  // overshooting the ceiling across any result shape or budget size.
  //
  // It asserts TWO independent properties per combination, because a length-only
  // assertion passes happily on a sliced truncation marker: a budget below a marker's
  // width makes truncateWithMarker emit a marker prefix such as "… [su", which honours
  // the ceiling while reading as a corrupted truncation notice. Marker integrity is
  // therefore checked alongside length.
  // =========================================================================
  describe("formatResultPreview ceiling-contract sweep", () => {
    const CEILINGS = [
      32_000, 20_000, 10_000, 5_000, 3_700, 2_000, 1_000, 500, 200, 100, 50, 20, 10, 5, 1, 0,
    ];
    const LONG_PATH = "x".repeat(500);

    // Every marker this module emits has the shape "… [<text>]". A bare "…" that is not
    // followed by a complete bracketed marker is a sliced fragment. Sweep fixtures never
    // contain "…" in their own summary text, so any occurrence here originates from a marker.
    const WELL_FORMED_MARKER = /^… \[[^[\]]*\]/;
    function assertNoMangledMarker(label: string, ceiling: number, text: string) {
      for (let i = text.indexOf("…"); i !== -1; i = text.indexOf("…", i + 1)) {
        assert.ok(
          WELL_FORMED_MARKER.test(text.slice(i)),
          `[${label}] ceiling=${ceiling}: mangled marker fragment at index ${i}: ${JSON.stringify(
            text.slice(i, i + 40),
          )}`,
        );
      }
    }

    // Structural well-formedness: a 'Nested subagents:' heading must never appear
    // without content beneath it. A length check cannot see this defect because an
    // orphaned heading fits within the ceiling while producing meaningless output.
    function assertNoOrphanedNestedHeading(label: string, ceiling: number, text: string) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.trim() !== "Nested subagents:") continue;
        // Find the next non-empty line.
        let j = i + 1;
        while (j < lines.length && lines[j]?.trim() === "") j++;
        const next = lines[j]?.trim() ?? "";
        // The next non-empty line must be a nested entry (↳) or an omission marker (…).
        const hasContent = next.startsWith("↳") || next.startsWith("…");
        assert.ok(
          hasContent,
          `[${label}] ceiling=${ceiling}: orphaned 'Nested subagents:' heading at line ${i} — next non-empty line: ${JSON.stringify(next)}`,
        );
      }
    }

    function checkCeiling(label: string, makeResult: () => object) {
      it(`${label} — length <= ceiling and no mangled markers for all ${CEILINGS.length} ceilings`, () => {
        const result = makeResult() as Parameters<typeof buildCompletionDetails>[0];
        const details = buildCompletionDetails(result);
        assert.ok(
          typeof details._reformatPreview === "function",
          "_reformatPreview must be defined",
        );
        for (const ceiling of CEILINGS) {
          const preview = details._reformatPreview!(ceiling);
          assert.ok(
            preview.length <= ceiling,
            `[${label}] ceiling=${ceiling}: preview.length=${preview.length} > ceiling`,
          );
          assertNoMangledMarker(label, ceiling, preview);
          assertNoOrphanedNestedHeading(label, ceiling, preview);
        }
      });
    }

    // Zero children — already correct before the fix, included as a baseline.
    checkCeiling("0 children", () => ({
      id: "sweep-0ch",
      agent: "worker",
      success: true,
      summary: "x".repeat(9_000),
      timestamp: 1,
    }));

    // Single child.
    checkCeiling("1 child", () => ({
      id: "sweep-1ch",
      agent: "worker",
      success: true,
      summary: "done",
      timestamp: 1,
      results: [
        {
          agent: "worker",
          status: "completed",
          summary: "x".repeat(9_000),
          artifactPath: "/artifacts/worker.md",
          sessionPath: "/sessions/worker.jsonl",
          index: 0,
        },
      ],
    }));

    // Two children.
    checkCeiling("2 children", () => ({
      id: "sweep-2ch",
      agent: "parallel:a+b",
      success: true,
      summary: "done",
      timestamp: 1,
      results: [
        {
          agent: "a",
          status: "completed",
          summary: "x".repeat(9_000),
          artifactPath: "/a.md",
          sessionPath: "/a.jsonl",
          index: 0,
        },
        {
          agent: "b",
          status: "completed",
          summary: "x".repeat(9_000),
          artifactPath: "/b.md",
          sessionPath: "/b.jsonl",
          index: 1,
        },
      ],
    }));

    // Eight children.
    checkCeiling("8 children", () => ({
      id: "sweep-8ch",
      agent: "parallel:8",
      success: false,
      state: "failed",
      summary: "outer",
      timestamp: 1,
      results: Array.from({ length: 8 }, (_, i) => ({
        agent: `worker-${i}`,
        status: i === 7 ? "failed" : "completed",
        summary: "x".repeat(9_000),
        artifactPath: `/artifacts/worker-${i}.md`,
        sessionPath: `/sessions/worker-${i}.jsonl`,
        index: i,
      })),
    }));

    // Failed outer WITH a failed child — isUnrepresentedOuterFailure = false.
    checkCeiling("failed outer with failed child", () => ({
      id: "sweep-fail-outer-with-failed",
      agent: "chain:a+b",
      success: false,
      state: "failed",
      summary: "x".repeat(9_000),
      timestamp: 1,
      results: [
        {
          agent: "a",
          status: "completed",
          summary: "x".repeat(9_000),
          artifactPath: "/a.md",
          sessionPath: "/a.jsonl",
          index: 0,
        },
        {
          agent: "b",
          status: "failed",
          summary: "x".repeat(9_000),
          artifactPath: "/b.md",
          sessionPath: "/b.jsonl",
          index: 1,
        },
      ],
    }));

    // Failed outer WITHOUT a failed child — isUnrepresentedOuterFailure = true.
    checkCeiling("failed outer without failed child", () => ({
      id: "sweep-fail-outer-no-failed",
      agent: "chain:a+b",
      success: false,
      state: "failed",
      summary: "x".repeat(9_000),
      timestamp: 1,
      results: [
        {
          agent: "a",
          status: "completed",
          summary: "x".repeat(9_000),
          artifactPath: "/a.md",
          sessionPath: "/a.jsonl",
          index: 0,
        },
        {
          agent: "b",
          status: "completed",
          summary: "x".repeat(9_000),
          artifactPath: "/b.md",
          sessionPath: "/b.jsonl",
          index: 1,
        },
      ],
    }));

    // Nested children (exercises the nested-entries budget).
    checkCeiling("nested children", () => ({
      id: "sweep-nested",
      agent: "parallel:nested",
      success: true,
      summary: "done",
      timestamp: 1,
      results: [
        {
          agent: "a",
          status: "completed",
          summary: "x".repeat(3_000),
          artifactPath: "/a.md",
          sessionPath: "/a.jsonl",
          index: 0,
          children: Array.from({ length: 6 }, (_, i) => ({
            agent: `nested-${i}`,
            state: "completed",
            children: [{ agent: `deep-${i}`, state: "completed" }],
          })),
        },
        {
          agent: "b",
          status: "completed",
          summary: "x".repeat(3_000),
          artifactPath: "/b.md",
          sessionPath: "/b.jsonl",
          index: 1,
        },
      ],
    }));

    // 500-char reference paths — the paths that make per-child scaffold expensive.
    checkCeiling("500-char reference paths", () => ({
      id: "sweep-500path",
      agent: "parallel:longpaths",
      success: false,
      state: "failed",
      summary: "x".repeat(9_000),
      timestamp: 1,
      results: Array.from({ length: 4 }, (_, i) => ({
        agent: `worker-${i}`,
        status: i === 3 ? "failed" : "completed",
        summary: "x".repeat(9_000),
        artifactPath: LONG_PATH,
        sessionPath: LONG_PATH,
        index: i,
      })),
    }));

    // Protected lifecycle — 2 children with nested subagents (minimal shape).
    checkCeiling("protected lifecycle 2 children with nested", () => ({
      id: "sweep-protected-2ch",
      agent: "parallel:a+b",
      success: false,
      state: "paused",
      pause: { kind: "awaiting_supervisor" },
      summary: "x".repeat(9_000),
      timestamp: 1,
      results: Array.from({ length: 2 }, (_, i) => ({
        agent: `worker-${i}`,
        status: "paused",
        summary: "x".repeat(9_000),
        index: i,
        children: Array.from({ length: 5 }, (_, j) => ({
          agent: `nested-${i}-${j}`,
          state: "paused",
        })),
      })),
    }));

    // Protected lifecycle — 8 children each with nested subagents (saturated budget shape).
    checkCeiling("protected lifecycle 8 children with nested", () => ({
      id: "sweep-protected-8ch",
      agent: "parallel:8",
      success: false,
      state: "paused",
      pause: { kind: "awaiting_supervisor" },
      summary: "x".repeat(9_000),
      timestamp: 1,
      results: Array.from({ length: 8 }, (_, i) => ({
        agent: `worker-${i}`,
        status: "paused",
        summary: "x".repeat(9_000),
        index: i,
        children: Array.from({ length: 5 }, (_, j) => ({
          agent: `nested-${i}-${j}`,
          state: "paused",
        })),
      })),
    }));

    // Protected lifecycle — zero children (returns 'Paused awaiting supervisor.').
    checkCeiling("protected lifecycle 0 children", () => ({
      id: "sweep-protected-0ch",
      agent: "parallel:0",
      success: false,
      state: "paused",
      pause: { kind: "awaiting_supervisor" },
      summary: "done",
      timestamp: 1,
      results: [],
    }));

    // Protected lifecycle — one child (also returns 'Paused awaiting supervisor.').
    checkCeiling("protected lifecycle 1 child", () => ({
      id: "sweep-protected-1ch",
      agent: "parallel:1",
      success: false,
      state: "paused",
      pause: { kind: "awaiting_supervisor" },
      summary: "done",
      timestamp: 1,
      results: [{ agent: "worker-0", status: "paused", summary: "x".repeat(9_000), index: 0 }],
    }));
  });

  // =========================================================================
  // Orphaned-heading regression: 8 protected children with 5 nested entries each
  // at the default ceiling (32 000). The shared nested budget is exhausted after
  // two children; without the fix, children 3–8 each rendered a bare
  // 'Nested subagents:' heading with nothing beneath it (six orphaned headings).
  // =========================================================================
  it("no orphaned 'Nested subagents:' heading with 8 protected children and 5 nested entries each at the default ceiling", () => {
    const result = {
      id: "orphan-regression",
      agent: "parallel:8",
      success: false,
      state: "paused" as const,
      pause: { kind: "awaiting_supervisor" },
      summary: "paused",
      timestamp: 1,
      results: Array.from({ length: 8 }, (_, i) => ({
        agent: `w${i + 1}`,
        status: "failed" as const,
        summary: "summary",
        children: Array.from({ length: 5 }, (_, j) => ({
          agent: `nested-${i + 1}-${j + 1}`,
          id: `id-${i + 1}-${j + 1}`,
          state: "completed",
        })),
      })),
    };
    const details = buildCompletionDetails(result as Parameters<typeof buildCompletionDetails>[0]);
    const preview = details._reformatPreview!(32_000);
    const lines = preview.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.trim() !== "Nested subagents:") continue;
      let j = i + 1;
      while (j < lines.length && lines[j]?.trim() === "") j++;
      const next = lines[j]?.trim() ?? "";
      assert.ok(
        next.startsWith("↳") || next.startsWith("…"),
        `orphaned 'Nested subagents:' at line ${i}; next non-empty: ${JSON.stringify(next)}`,
      );
    }
  });

  // =========================================================================
  // Protected-lifecycle privacy: no summary text in output.
  //
  // The protected-lifecycle path deliberately omits child and outer summaries
  // so no sensitive context leaks in the preview. This test asserts that the
  // privacy guarantee holds across ceilings and is never broken by the fix.
  // =========================================================================
  it("protected lifecycle preview contains no child or outer summary text", () => {
    const SENTINEL = "SENTINEL_SECRET_TEXT";
    const result = {
      id: "privacy-check",
      agent: "parallel:a+b",
      success: false,
      state: "paused",
      pause: { kind: "awaiting_supervisor" },
      summary: `Outer: ${SENTINEL}`,
      timestamp: 1,
      results: Array.from({ length: 4 }, (_, i) => ({
        agent: `worker-${i}`,
        status: "paused",
        summary: `Child ${i}: ${SENTINEL}`,
        index: i,
        children: Array.from({ length: 3 }, (_, j) => ({
          agent: `nested-${i}-${j}`,
          state: "paused",
        })),
      })),
    };
    const details = buildCompletionDetails(result as Parameters<typeof buildCompletionDetails>[0]);
    for (const ceiling of [32_000, 1_000, 100, 0]) {
      const preview = details._reformatPreview!(ceiling);
      assert.ok(
        !preview.includes(SENTINEL),
        `ceiling=${ceiling}: preview must not contain summary sentinel text, got: ${JSON.stringify(preview.slice(0, 200))}`,
      );
    }
  });

  // =========================================================================
  // Acceptance criterion 3: pointer-survival at every batch size.
  //
  // In a grouped batch where one entry is a parent with 8 saturated children,
  // ALL 8 inner artifact pointers must be retained. Pre-fix: 1 of 8 survived
  // at batch size 8 because the oversized preview (17 000+ chars) was end-cut
  // at the previewCeiling, destroying the refs that live at the tail.
  // =========================================================================
  for (const batchSize of [2, 8, 20, 40] as const) {
    it(`inner-child artifact pointers: 8 of 8 must survive in a grouped batch of ${batchSize}`, () => {
      // The multi-child parent: 8 children, each with saturated summary and artifact+session.
      const parentDetails = buildCompletionDetails({
        id: `ptr-survival-parent-${batchSize}`,
        runId: null,
        agent: "parallel:8",
        success: true,
        summary: "outer done",
        timestamp: 1,
        results: Array.from({ length: 8 }, (_, i) => ({
          agent: `worker-${i}`,
          status: "completed" as const,
          summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
          artifactPath: `/tmp/artifacts/worker-${i}.md`,
          sessionPath: `/tmp/sessions/worker-${i}.jsonl`,
          index: i,
        })),
      });
      // Fill the rest of the batch with saturated single-agent completions.
      const fillers: SubagentNotifyDetails[] = Array.from({ length: batchSize - 1 }, (_, i) => ({
        agent: `filler-${i}`,
        status: "completed" as const,
        resultPreview: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
      }));
      const result = formatGroupedCompletion([parentDetails, ...fillers]);

      // 1. Message must fit the ceiling.
      assert.ok(
        result.length <= MAX_COMPLETION_MESSAGE_CHARS,
        `grouped message (${result.length}) must fit MAX_COMPLETION_MESSAGE_CHARS at batch size ${batchSize}`,
      );

      // 2. All 8 inner artifact pointers must survive (pre-fix: only 1 survived at batch size 8).
      const innerArtifactCount = Array.from({ length: 8 }, (_, i) =>
        result.includes(`Output artifact: /tmp/artifacts/worker-${i}.md`) ? 1 : 0,
      ).reduce((a: number, b: number) => a + b, 0);
      assert.equal(
        innerArtifactCount,
        8,
        `expected 8 inner artifact pointers but found ${innerArtifactCount} at batch size ${batchSize}`,
      );
    });
  }

  // Acceptance criterion 4: no mangled truncation-marker fragments in any output.
  // At very tight ceilings, summary lines must be suppressed entirely rather than
  // producing fragments like "… [su" or "… [summary tru".
  it("no mangled truncation-marker fragments at any ceiling", () => {
    const CEILINGS = [32_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100];
    const MANGLED_RE = /… \[s(?!ummary truncated\])/; // "… [s" not followed by "ummary truncated]"
    const completionFixtures = [
      // Single child with outer failure.
      {
        id: "mangle-1ch-outer",
        agent: "worker",
        success: false,
        state: "failed",
        summary: "x".repeat(9_000),
        timestamp: 1,
        results: [{ agent: "worker", status: "completed", summary: "y".repeat(9_000), index: 0 }],
      },
      // Eight children, outer failure without failed child.
      {
        id: "mangle-8ch",
        agent: "parallel",
        success: false,
        state: "failed",
        summary: "x".repeat(9_000),
        timestamp: 1,
        results: Array.from({ length: 8 }, (_, i) => ({
          agent: `worker-${i}`,
          status: "completed",
          summary: "y".repeat(9_000),
          artifactPath: `/a-${i}.md`,
          sessionPath: `/s-${i}.jsonl`,
          index: i,
        })),
      },
    ];
    for (const completionFixture of completionFixtures) {
      const details = buildCompletionDetails(
        completionFixture as Parameters<typeof buildCompletionDetails>[0],
      );
      for (const ceiling of CEILINGS) {
        const preview = details._reformatPreview!(ceiling);
        assert.ok(
          !MANGLED_RE.test(preview),
          `[${completionFixture.id}] ceiling=${ceiling}: mangled marker found in preview: ${JSON.stringify(preview.slice(0, 80))}`,
        );
      }
    }
  });

  // =========================================================================
  // Sanity check: realistic summaries (not saturated) remain completely untruncated
  // with all 8 child reference lines present after the reservation fix.
  // =========================================================================
  it("realistic 4-child result (~3 000 chars each) remains completely untruncated with all reference lines", () => {
    const { events, sentMessages } = createPi();
    const shareUrl = "https://share/realistic-sanity";

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "realistic-sanity",
      agent: "parallel",
      success: true,
      summary: "done",
      timestamp: 1,
      sessionId: "session-1",
      shareUrl,
      results: Array.from({ length: 4 }, (_, index) => ({
        agent: `worker-${index}`,
        status: "completed",
        summary: "x".repeat(3_000),
        index,
        artifactPath: `/tmp/artifacts/worker-${index}.md`,
        sessionPath: `/tmp/sessions/worker-${index}.jsonl`,
      })),
    });

    assert.equal(sentMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;

    // 1. Message fits the ceiling.
    assert.ok(content.length <= MAX_COMPLETION_MESSAGE_CHARS);

    // 2. No truncation marker anywhere in the content.
    assert.ok(
      !content.includes("[summary truncated]"),
      "realistic summaries at ~3 000 chars must not be truncated",
    );

    // 3. All 8 reference lines (2 per child × 4 children) are present.
    for (let i = 0; i < 4; i++) {
      assert.ok(
        content.includes(`Output artifact: /tmp/artifacts/worker-${i}.md`),
        `child ${i} artifact reference must be present untruncated`,
      );
      assert.ok(
        content.includes(`Session: /tmp/sessions/worker-${i}.jsonl`),
        `child ${i} session reference must be present untruncated`,
      );
    }

    // 4. Outer session also present.
    assert.ok(content.includes(`Session: ${shareUrl}`), "outer session pointer must be present");
  });

  // ---------------------------------------------------------------------------
  // Acceptance rejection visibility in completion notifications (ticket tlhm-rzlp)
  // ---------------------------------------------------------------------------

  it("single-child rejection with a diagnosable reason shows the rejection marker and reason", () => {
    const { events, sentMessages } = createPi();
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "acceptance-rejected-reason",
      agent: "worker",
      success: true,
      summary: "done",
      timestamp: 1,
      sessionId: "session-1",
      results: [
        {
          agent: "worker",
          status: "completed",
          summary: "Done with work",
          acceptance: {
            status: "rejected",
            explicit: true,
            effectiveAcceptance: { level: "checked" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [
              {
                id: "evidence:no-staged-files",
                status: "failed",
                message: "Staged files present: src/file.ts",
              },
            ],
            verifyRuns: [],
          },
        },
      ],
    });
    assert.equal(sentMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;
    assert.match(content, /Acceptance: rejected \u2014 Staged files present: src\/file\.ts/);
    // Summary is still present
    assert.match(content, /Done with work/);
  });

  it("single-child rejection with no diagnosable reason shows the marker only", () => {
    const { events, sentMessages } = createPi();
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "acceptance-rejected-no-reason",
      agent: "worker",
      success: true,
      summary: "done",
      timestamp: 1,
      sessionId: "session-1",
      results: [
        {
          agent: "worker",
          status: "completed",
          summary: "Done",
          acceptance: {
            status: "rejected",
            explicit: true,
            effectiveAcceptance: { level: "checked" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [],
            verifyRuns: [],
          },
        },
      ],
    });
    assert.equal(sentMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;
    // Positive control: bare rejection marker is present
    assert.match(content, /Acceptance: rejected/);
    // No dash-reason suffix when there is no diagnosable cause
    assert.doesNotMatch(content, /Acceptance: rejected \u2014/);
  });

  it("rejection reason longer than 200 chars is truncated with an ellipsis", () => {
    const { events, sentMessages } = createPi();
    const longReason = "x".repeat(250);
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "acceptance-rejected-long",
      agent: "worker",
      success: true,
      summary: "done",
      timestamp: 1,
      sessionId: "session-1",
      results: [
        {
          agent: "worker",
          status: "completed",
          summary: "Done",
          acceptance: {
            status: "rejected",
            explicit: true,
            effectiveAcceptance: { level: "checked" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [
              { id: "evidence:changed-files", status: "failed", message: longReason },
            ],
            verifyRuns: [],
          },
        },
      ],
    });
    assert.equal(sentMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;
    // Truncated to 199 content chars + 1 ellipsis = 200 code units
    assert.match(content, /Acceptance: rejected \u2014 x{199}\u2026/);
    // Full 250-char reason must not appear verbatim
    assert.doesNotMatch(content, new RegExp("x{200}"));
  });

  it("normalizes newlines in rejection reason to prevent line injection in notifications", () => {
    const { events, sentMessages } = createPi();
    const poisonReason = "first line\nsecond line\r\nthird line";
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "acceptance-rejected-newline",
      agent: "worker",
      success: true,
      summary: "done",
      timestamp: 1,
      sessionId: "session-1",
      results: [
        {
          agent: "worker",
          status: "completed",
          summary: "Done",
          acceptance: {
            status: "rejected",
            explicit: true,
            effectiveAcceptance: { level: "checked" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [
              { id: "evidence:changed-files", status: "failed", message: poisonReason },
            ],
            verifyRuns: [],
          },
        },
      ],
    });
    assert.equal(sentMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;
    // All three segments must appear joined on a single line, not forged as separate lines
    assert.match(content, /first line second line third line/);
    // The injected lines must not appear as separate content lines
    assert.doesNotMatch(content, /^second line$/m);
    assert.doesNotMatch(content, /^third line$/m);
  });

  it("truncates rejection reason at exactly 200 code units (shared-constant boundary)", () => {
    // 200-char reason must NOT be truncated.
    const { events: evExact, sentMessages: sentExact } = createPi();
    const exactReason = "B".repeat(200);
    evExact.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "acceptance-rejected-exact",
      agent: "worker",
      success: true,
      summary: "done",
      timestamp: 2,
      sessionId: "session-1",
      results: [
        {
          agent: "worker",
          status: "completed",
          summary: "Done",
          acceptance: {
            status: "rejected",
            explicit: true,
            effectiveAcceptance: { level: "checked" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [
              { id: "evidence:changed-files", status: "failed", message: exactReason },
            ],
            verifyRuns: [],
          },
        },
      ],
    });
    assert.equal(sentExact.length, 1);
    const contentExact = (sentExact[0]!.message as { content: string }).content;
    assert.match(contentExact, new RegExp("B{200}"));
    assert.doesNotMatch(contentExact, /\u2026/);

    // 201-char reason must be truncated.
    const { events: evOver, sentMessages: sentOver } = createPi();
    const overReason = "C".repeat(201);
    evOver.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "acceptance-rejected-over",
      agent: "worker",
      success: true,
      summary: "done",
      timestamp: 3,
      sessionId: "session-1",
      results: [
        {
          agent: "worker",
          status: "completed",
          summary: "Done",
          acceptance: {
            status: "rejected",
            explicit: true,
            effectiveAcceptance: { level: "checked" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [
              { id: "evidence:changed-files", status: "failed", message: overReason },
            ],
            verifyRuns: [],
          },
        },
      ],
    });
    assert.equal(sentOver.length, 1);
    const contentOver = (sentOver[0]!.message as { content: string }).content;
    assert.match(contentOver, /\u2026/);
    assert.doesNotMatch(contentOver, new RegExp("C{201}"));
  });

  it("non-rejected acceptance statuses add no acceptance noise to the notification", () => {
    const { events, sentMessages } = createPi();
    const nonRejectedStatuses = ["attested", "checked", "verified", "skipped", "not-required"];
    for (const status of nonRejectedStatuses) {
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: `acceptance-non-rejected-${status}`,
        agent: "worker",
        success: true,
        summary: "done",
        timestamp: Date.now() + Math.random() * 1e9,
        sessionId: "session-1",
        results: [
          {
            agent: "worker",
            status: "completed",
            summary: "Done",
            acceptance: {
              status,
              explicit: true,
              effectiveAcceptance: { level: "checked" },
              inferredReason: [],
              criteria: [],
              runtimeChecks: [],
              verifyRuns: [],
            },
          },
        ],
      });
    }
    assert.equal(sentMessages.length, nonRejectedStatuses.length);
    for (const msg of sentMessages) {
      const content = (msg.message as { content: string }).content;
      assert.doesNotMatch(
        content,
        /[Aa]cceptance:/,
        `acceptance line must not appear for non-rejected status`,
      );
    }
  });

  it("child with no acceptance ledger renders exactly as before", () => {
    const { events, sentMessages } = createPi();
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "no-acceptance-ledger",
      agent: "worker",
      success: true,
      summary: "done",
      timestamp: 1,
      sessionId: "session-1",
      results: [
        {
          agent: "worker",
          status: "completed",
          summary: "Done without acceptance",
        },
      ],
    });
    assert.equal(sentMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;
    assert.doesNotMatch(content, /[Aa]cceptance:/);
    assert.match(content, /Done without acceptance/);
  });

  it("grouped path shows rejection markers for each rejected child", () => {
    const { events, sentMessages } = createPi();
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "grouped-acceptance-rejected",
      agent: "parallel:a+b",
      success: true,
      summary: "combined",
      timestamp: 1,
      sessionId: "session-1",
      results: [
        {
          agent: "a",
          status: "completed",
          summary: "A done",
          acceptance: {
            status: "rejected",
            explicit: true,
            effectiveAcceptance: { level: "checked" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [
              { id: "evidence:no-staged-files", status: "failed", message: "Staged files: a.ts" },
            ],
            verifyRuns: [],
          },
        },
        {
          agent: "b",
          status: "completed",
          summary: "B done",
          acceptance: {
            status: "checked",
            explicit: true,
            effectiveAcceptance: { level: "checked" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [],
            verifyRuns: [],
          },
        },
      ],
    });
    assert.equal(sentMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;
    // Child a: rejected, marker must appear
    assert.match(content, /Acceptance: rejected \u2014 Staged files: a\.ts/);
    // Child b: checked, no acceptance noise
    const childBSection = content.slice(content.indexOf("2/2. b"));
    assert.doesNotMatch(childBSection, /Acceptance:/);
    // Only one acceptance rejection line in the whole message
    assert.equal((content.match(/Acceptance: rejected/g) ?? []).length, 1);
  });
});
