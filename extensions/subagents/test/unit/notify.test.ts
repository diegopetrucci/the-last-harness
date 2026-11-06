import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentNotify, {
  isSubagentCompletionBatchDetails,
  MAX_COMPLETION_BATCH_ENTRIES,
  MAX_COMPLETION_BATCH_CHUNKS,
  MAX_COMPLETION_MESSAGE_CHARS,
  MAX_DISPLAY_SUMMARY_CHARS,
  MAX_GROUPED_ENTRIES,
  type SubagentCompletionBatchDetails,
  type SubagentNotifyDetails,
} from "../../src/runs/background/notify.ts";
import {
  COMPLETION_DELIVERY,
  type CompletionDeliveryMetadata,
} from "../../src/runs/background/completion-dedupe.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";
import {
  NUDGE_TEXT,
  completionResult,
  createBatchingPi,
  createFakeClock,
  createPi,
} from "../support/notify-fixtures.ts";

describe("registerSubagentNotify", () => {
  it("uses a fallback summary when a background completion is empty", () => {
    const { events, sentMessages, sentUserMessages } = createPi();

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-empty-1",
      agent: "worker",
      success: true,
      summary: "",
      exitCode: 0,
      timestamp: 123,
      sessionId: "session-1",
    });

    // E′ protocol: one sendMessage (no options) + one sendUserMessage nudge (idle path)
    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
    assert.deepEqual(sentMessages[0], {
      message: {
        customType: "subagent-notify",
        content: "Background task completed: **worker**\n\nAsync id: notify-empty-1\n\n(no output)",
        display: true,
        details: {
          agent: "worker",
          status: "completed",
          resultPreview: "",
          asyncId: "notify-empty-1",
        },
      },
      options: undefined,
    });
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("preserves non-empty completion summaries", () => {
    const { events, sentMessages, sentUserMessages } = createPi();
    const summary = "  Done streaming\nAll clear  ";

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-summary-1",
      agent: "worker",
      success: true,
      summary,
      exitCode: 0,
      timestamp: 456,
      taskIndex: 1,
      totalTasks: 3,
      sessionId: "session-1",
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
    assert.deepEqual(sentMessages[0], {
      message: {
        customType: "subagent-notify",
        content: `Background task completed: **worker** (2/3)\n\nAsync id: notify-summary-1\n\n${summary}`,
        display: true,
        details: {
          agent: "worker",
          status: "completed",
          taskInfo: " (2/3)",
          resultPreview: summary,
          asyncId: "notify-summary-1",
        },
      },
      options: undefined,
    });
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("shows async id and top-level resume guidance only when the session file exists", () => {
    const { events, sentMessages, sentUserMessages } = createPi();
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-single-session-"));
    const sessionFile = path.join(resultsDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "session\n", "utf-8");

    try {
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: "notify-event-1",
        runId: "notify-run-1",
        agent: "worker",
        success: true,
        summary: "Done",
        exitCode: 0,
        timestamp: 456,
        sessionFile,
        sessionId: "session-1",
      });
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }

    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
    assert.deepEqual(sentMessages[0], {
      message: {
        customType: "subagent-notify",
        content: `Background task completed: **worker**\n\nAsync id: notify-event-1\nRevive: subagent({ action: "resume", id: "notify-event-1", message: "..." })\n\nDone\n\nSession file: ${sessionFile}`,
        display: true,
        details: {
          agent: "worker",
          status: "completed",
          resultPreview: "Done",
          asyncId: "notify-event-1",
          resumeTarget: { sessionPath: sessionFile },
          sessionLabel: "Session file",
          sessionValue: sessionFile,
        },
      },
      options: undefined,
    });
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("does not advertise resume guidance when the session file is missing", () => {
    const { events, sentMessages, sentUserMessages } = createPi();
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-missing-session-"));
    const missingSession = path.join(resultsDir, "missing-session.jsonl");

    try {
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: null,
        runId: "notify-run-fallback",
        agent: "worker",
        success: true,
        summary: "Done",
        exitCode: 0,
        timestamp: 456,
        sessionFile: missingSession,
        sessionId: "session-1",
      });

      assert.equal(sentMessages.length, 1);
      assert.equal(sentUserMessages.length, 1);
      assert.deepEqual(sentMessages[0], {
        message: {
          customType: "subagent-notify",
          content: `Background task completed: **worker**\n\nAsync id: notify-run-fallback\n\nDone\n\nSession file: ${missingSession}`,
          display: true,
          details: {
            agent: "worker",
            status: "completed",
            resultPreview: "Done",
            asyncId: "notify-run-fallback",
            sessionLabel: "Session file",
            sessionValue: missingSession,
          },
        },
        options: undefined,
      });
      assert.deepEqual(sentUserMessages[0], {
        content: NUDGE_TEXT,
        options: { deliverAs: "followUp" },
      });
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("labels paused completions as paused even without an exit code", () => {
    const { events, sentMessages, sentUserMessages } = createPi();

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-paused-1",
      agent: "worker",
      success: false,
      state: "paused",
      summary: "Paused after interrupt. Waiting for explicit next action.",
      timestamp: 789,
      sessionId: "session-1",
    });

    // Paused runs bypass grouping and emit immediately; idle path → nudge
    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
    assert.deepEqual(sentMessages[0], {
      message: {
        customType: "subagent-notify",
        content:
          "Background task paused: **worker**\n\nAsync id: notify-paused-1\n\nPaused after interrupt. Waiting for explicit next action.",
        display: true,
        details: {
          agent: "worker",
          status: "paused",
          resultPreview: "Paused after interrupt. Waiting for explicit next action.",
          asyncId: "notify-paused-1",
        },
      },
      options: undefined,
    });
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("formats normalized child results into one native completion notice", () => {
    const { events, sentMessages, sentUserMessages } = createPi();

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-grouped-1",
      agent: "parallel:a+b",
      success: false,
      state: "failed",
      summary: "Combined summary",
      timestamp: 100,
      sessionId: "session-1",
      results: [
        {
          agent: "a",
          status: "completed",
          summary: "Result from a",
          sessionPath: "/tmp/a-session.jsonl",
          artifactPath: "/tmp/a-output.md",
        },
        {
          agent: "b",
          status: "failed",
          summary: "B failed\n\nOutput:\nResult from b",
        },
      ],
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;
    assert.match(content, /^Background task failed: \*\*parallel:a\+b\*\*/);
    assert.match(content, /Children: 1 completed, 1 failed/);
    assert.match(
      content,
      /1\/2\. a — completed\nResult from a\nOutput artifact: \/tmp\/a-output\.md\nSession: \/tmp\/a-session\.jsonl/,
    );
    assert.match(content, /2\/2\. b — failed\nB failed\n\nOutput:\nResult from b/);
    // sendMessage has no options (no triggerTurn)
    assert.equal(sentMessages[0]!.options, undefined);
    // nudge is sent once (idle path, fails bypass grouping)
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("prioritizes failed and paused children with original numbering and resumable indexes", () => {
    const { events, sentMessages, sentUserMessages } = createPi();
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-urgent-children-"));
    const completedSession = path.join(resultsDir, "child-1.jsonl");
    const failedSession = path.join(resultsDir, "child-9.jsonl");
    fs.writeFileSync(completedSession, "session\n", "utf-8");
    fs.writeFileSync(failedSession, "session\n", "utf-8");
    const results = Array.from({ length: 10 }, (_, index) => ({
      agent: `worker-${index}`,
      status: index === 8 ? "failed" : index === 9 ? "paused" : "completed",
      // Sized above the per-child budget at this fan-out (8 displayed -> 4 000 each) so the
      // notice still exercises a capped scenario, as it did against the original 1 200 cap.
      summary: `${index}: ${"x".repeat(4_500)}`,
      ...(index === 0
        ? { sessionPath: completedSession, index }
        : index === 8
          ? { sessionPath: failedSession, index }
          : { index }),
    }));

    try {
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: "notify-urgent-1",
        runId: "notify-urgent-run-1",
        agent: "parallel:urgent",
        success: true,
        summary: "outer",
        timestamp: 100,
        sessionId: "session-1",
        results,
      });
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }

    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
    const content = (sentMessages[0]!.message as { content: string }).content;
    assert.ok(content.length <= MAX_COMPLETION_MESSAGE_CHARS);
    assert.match(content, /^Background task failed: \*\*parallel:urgent\*\*/);
    assert.match(content, /Children: 8 completed, 1 failed, 1 paused/);
    assert.match(content, /… \[2 child results omitted\]/);
    // A single parallel run is one item: its preview shows at most 8 children (the rest omitted).
    assert.doesNotMatch(content, /\b7\/10\. worker-6/);
    assert.doesNotMatch(content, /\b8\/10\. worker-7/);
    assert.match(content, /9\/10\. worker-8 — failed/);
    assert.match(content, /10\/10\. worker-9 — paused/);
    assert.match(content, /Async id: notify-urgent-1/);
    assert.match(
      content,
      /Revive child: subagent\({ action: "resume", id: "notify-urgent-1", index: 8, message: "\.\.\." }\)/,
    );
    assert.doesNotMatch(content, /Async id: notify-urgent-run-1/);
    assert.ok(
      content.indexOf("Async id: notify-urgent-1") <
        content.indexOf("Children: 8 completed, 1 failed, 1 paused"),
    );
    assert.ok(
      content.indexOf("9/10. worker-8 — failed") < content.indexOf("1/10. worker-0 — completed"),
    );
    assert.ok(
      content.includes("9/10. worker-8 — failed"),
      "urgent child details must survive the final completion cap",
    );
    // Tail-preserving truncation shrinks the preview body rather than end-cutting the
    // assembled message, so the absolute backstop marker stays unreachable even at this
    // fan-out. Per-summary truncation still applies (see marker below).
    assert.ok(
      !content.includes("… [completion message truncated]"),
      "tail-preserving truncation must keep the absolute backstop unreachable",
    );
    assert.match(content, /… \[summary truncated\]/);
    // sendMessage no options; nudge once (idle, failed — immediate path)
    assert.equal(sentMessages[0]!.options, undefined);
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("bounds oversized single-notice content and attached preview while retaining status and safe references", () => {
    const { events, sentMessages, sentUserMessages } = createPi();
    const results = Array.from({ length: 10 }, (_, index) => ({
      agent: `worker-${index}`,
      status: index === 9 ? "failed" : "completed",
      summary: `${index}: ${"x".repeat(4_000)}`,
      ...(index === 0
        ? {
            artifactPath: "/safe/artifacts/worker-0.md",
            sessionPath: "/safe/sessions/worker-0.jsonl",
            intercomTarget: "stale-target-must-not-appear",
          }
        : {}),
    }));

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-oversized-1",
      agent: "parallel:oversized",
      success: true,
      summary: "outer",
      timestamp: 100,
      sessionId: "session-1",
      intercomTarget: "stale-owner-target-must-not-appear",
      results,
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
    // No options on sendMessage
    assert.equal(sentMessages[0]!.options, undefined);
    const message = sentMessages[0]!.message as {
      content: string;
      details?: SubagentNotifyDetails;
    };
    const content = message.content;
    assert.ok(content.length <= MAX_COMPLETION_MESSAGE_CHARS);
    assert.ok(message.details, "single notices must retain structured metadata");
    assert.equal(message.details.asyncId, "notify-oversized-1");
    assert.ok(message.details.resultPreview.length <= MAX_DISPLAY_SUMMARY_CHARS);
    assert.match(message.details.resultPreview, /… \[summary truncated\]$/);
    assert.match(content, /^Background task failed: \*\*parallel:oversized\*\*/);
    assert.match(content, /Children: 9 completed, 1 failed/);
    assert.match(content, /… \[2 child results omitted\]/);
    assert.match(content, /… \[summary truncated\]/);
    assert.match(content, /Output artifact: \/safe\/artifacts\/worker-0\.md/);
    assert.match(content, /Session: \/safe\/sessions\/worker-0\.jsonl/);
    // Oversized per-child summaries are clamped to the fixed per-child budget, so the
    // assembled message fits the envelope without the backstop firing. This is what keeps the
    // trailing recovery references (asserted above) from being truncated away.
    assert.ok(
      !content.includes("… [completion message truncated]"),
      "per-child-budgeted summaries must leave envelope headroom so the backstop does not fire",
    );
    assert.ok(content.length <= MAX_COMPLETION_MESSAGE_CHARS);
    assert.doesNotMatch(content, /stale-target/);
    // nudge sent once (idle, failed — immediate path)
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("redacts protected paused lifecycle paths from content and structured details", () => {
    const { events, sentMessages, sentUserMessages } = createPi();
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-paused-private-"));
    const sessionPath = path.join(resultsDir, "private-session.jsonl");
    fs.writeFileSync(sessionPath, "session\n", "utf-8");
    try {
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: "notify-paused-private",
        agent: "parallel:a+b",
        success: false,
        state: "paused",
        pause: { kind: "awaiting_supervisor" },
        summary: "Paused awaiting supervisor at /private/root/project after pid 43210.",
        timestamp: 100,
        sessionId: "session-1",
        shareUrl: "https://share/private-run",
        results: [
          {
            agent: "a",
            status: "completed",
            summary: "done at /private/root/a.ts",
            artifactPath: "/private/artifacts/a.md",
            sessionPath,
            index: 0,
          },
          {
            agent: "b",
            status: "paused",
            summary: "paused pgid 54321",
            sessionPath,
            index: 1,
            children: [{ agent: "nested-b", state: "paused" }],
          },
        ],
      });
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }

    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
    assert.equal(sentMessages[0]!.options, undefined);
    const message = sentMessages[0]!.message as {
      content: string;
      details?: SubagentNotifyDetails;
    };
    assert.match(message.content, /^Background task paused: \*\*parallel:a\+b\*\*/);
    assert.match(message.content, /Async id: notify-paused-private/);
    assert.match(
      message.content,
      /Resume unchanged: subagent\({ action: "resume", id: "notify-paused-private", index: 1 }\)/,
    );
    assert.doesNotMatch(
      message.content,
      /private-run|private-session|\/private\/|pid 43210|pgid 54321|Output artifact:|Session:/,
    );
    assert.equal(message.details?.sessionValue, undefined);
    assert.deepEqual(message.details?.resumeTarget, { index: 1, childCount: 2 });
    assert.equal("sessionPath" in (message.details?.resumeTarget ?? {}), false);
    assert.doesNotMatch(
      JSON.stringify(message.details),
      /private-run|private-session|\/private\/|pid 43210|pgid 54321/,
    );
    assert.doesNotMatch(
      message.details?.resultPreview ?? "",
      /private-run|private-session|\/private\/|pid 43210|pgid 54321/,
    );
    assert.match(message.details?.resultPreview ?? "", /Children: 1 completed, 1 paused/);
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("bounds oversized share errors from a normalized chain in content and attached details", () => {
    const { events, sentMessages, sentUserMessages } = createPi();
    const shareError = `share failed: ${"sensitive-detail-".repeat(400)}unbounded-tail`;

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-oversized-share-error",
      agent: "chain:a+b",
      success: false,
      summary: "Done with a share failure",
      shareError,
      results: [
        { agent: "a", status: "completed", summary: "a done" },
        { agent: "b", status: "failed", summary: "Done with a share failure" },
      ],
      timestamp: 100,
      sessionId: "session-1",
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
    assert.equal(sentMessages[0]!.options, undefined);
    const message = sentMessages[0]!.message as {
      content: string;
      details?: SubagentNotifyDetails;
    };
    assert.ok(message.details);
    assert.equal(message.details.sessionLabel, "Session share error");
    assert.ok((message.details.sessionValue?.length ?? 0) <= 500);
    assert.match(message.details.sessionValue ?? "", /… \[reference truncated\]$/);
    assert.doesNotMatch(message.details.sessionValue ?? "", /unbounded-tail/);
    assert.match(message.content, /Session share error: .*… \[reference truncated\]$/);
    assert.doesNotMatch(message.content, /unbounded-tail/);
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("ignores completions for other or missing session ids", () => {
    const { events, sentMessages, sentUserMessages } = createPi("session-owner");

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-other-session",
      agent: "worker",
      success: true,
      summary: "Other done",
      timestamp: 100,
      sessionId: "session-other",
    });
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-sessionless",
      agent: "worker",
      success: true,
      summary: "Legacy cwd-scoped done",
      timestamp: 101,
      cwd: "/repo",
    });

    assert.deepEqual(sentMessages, []);
    assert.deepEqual(sentUserMessages, []);
  });

  it("reads idleness live at send time and sends no nudge while streaming", () => {
    const { events, sentMessages, sentUserMessages, lifecycleHandlers } = createPi("session-1");

    // Capture a session context whose isIdle() reads live state, mirroring
    // how Pi context methods are closures over the runner.
    let idle = false;
    lifecycleHandlers.get("session_start")?.({}, { isIdle: () => idle });

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-streaming-1",
      agent: "worker",
      success: true,
      summary: "Done while streaming",
      exitCode: 0,
      timestamp: 123,
      sessionId: "session-1",
    });

    // Custom message sent, but NO nudge (streaming path)
    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 0, "no nudge must be sent when session is streaming");
    assert.equal(sentMessages[0]!.options, undefined);
    const content = (sentMessages[0]!.message as { content: string }).content;
    assert.match(content, /^Background task completed: \*\*worker\*\*/);

    // The same captured context reports idle again — no re-capture needed;
    // the next completion must send the nudge.
    idle = true;

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-after-settle-1",
      agent: "worker",
      success: true,
      summary: "Done after settle",
      exitCode: 0,
      timestamp: 124,
      sessionId: "session-1",
    });

    assert.equal(sentMessages.length, 2);
    assert.equal(
      sentUserMessages.length,
      1,
      "nudge must be sent once the live idleness read reports idle",
    );
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("nudges when no session context has been captured yet (assumed idle)", () => {
    const { events, sentMessages, sentUserMessages } = createPi("session-1");

    // No session_start fired — sendCompletion must assume idle and nudge.
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-no-ctx-1",
      agent: "worker",
      success: true,
      summary: "Done",
      exitCode: 0,
      timestamp: 123,
      sessionId: "session-1",
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("emits failed completions immediately even while successes are held", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({ id: "ok-1", agent: "ok-1", summary: "ok-1 done" }),
    );
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "fail-1",
        agent: "fail-1",
        success: false,
        summary: "boom",
        exitCode: 1,
      }),
    );

    // The failure must arrive immediately, and the held success must be
    // flushed ahead of it rather than waiting on the debounce timer.
    assert.equal(sentMessages.length, 2);
    assert.match(
      (sentMessages[0]!.message as { content: string }).content,
      /Background task completed: \*\*ok-1\*\*/,
    );
    assert.match(
      (sentMessages[1]!.message as { content: string }).content,
      /Background task failed: \*\*fail-1\*\*/,
    );
    // Both messages sent without options (no triggerTurn)
    assert.equal(sentMessages[0]!.options, undefined);
    assert.equal(sentMessages[1]!.options, undefined);
    // Exactly one nudge for the whole synchronous burst (flush + failure)
    assert.equal(sentUserMessages.length, 1);
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });

    // No deferred emission should arrive later.
    clock.advance(1000);
    assert.equal(sentMessages.length, 2);
    assert.equal(sentUserMessages.length, 1);
  });

  it("sends exactly one nudge when a non-completion signal flushes held successes in one burst", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);

    // Two pending successes are held by the batcher.
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({ id: "held-1", agent: "held-1", summary: "held-1 done" }),
    );
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({ id: "held-2", agent: "held-2", summary: "held-2 done" }),
    );
    assert.equal(sentMessages.length, 0);
    assert.equal(sentUserMessages.length, 0);

    // A paused signal bypasses grouping: it flushes the held successes and
    // then emits itself, all in one synchronous burst.
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "paused-signal",
        agent: "paused-worker",
        success: false,
        state: "paused",
        summary: "Paused after interrupt.",
      }),
    );

    // Both messages delivered: the grouped successes and the paused signal.
    assert.equal(sentMessages.length, 2);
    assert.match(
      (sentMessages[0]!.message as { content: string }).content,
      /^Background tasks completed \(2\): \*\*held-1\*\*, \*\*held-2\*\*/,
    );
    assert.match(
      (sentMessages[1]!.message as { content: string }).content,
      /^Background task paused: \*\*paused-worker\*\*/,
    );
    // Exactly one nudge for the whole burst, carried by the trailing signal.
    assert.equal(sentUserMessages.length, 1, "a flush+signal burst must produce exactly one nudge");
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });

    clock.advance(1000);
    assert.equal(sentMessages.length, 2);
    assert.equal(sentUserMessages.length, 1);
  });

  it("treats an outer-success grouped result with a failed child as an immediate failure", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);
    const groupedFailure = completionResult({
      id: "grouped-child-failure-1",
      agent: "parallel:a+b",
      success: true,
      summary: "Combined summary",
      results: [
        { agent: "a", status: "completed", summary: "a done" },
        { agent: "b", status: "failed", summary: "b failed" },
      ],
    });

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({ id: "held-before-grouped-failure", agent: "held", summary: "held done" }),
    );
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, groupedFailure);
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, groupedFailure);

    assert.equal(sentMessages.length, 2);
    assert.match(
      (sentMessages[0]!.message as { content: string }).content,
      /^Background task completed: \*\*held\*\*/,
    );
    const failureContent = (sentMessages[1]!.message as { content: string }).content;
    assert.match(failureContent, /^Background task failed: \*\*parallel:a\+b\*\*/);
    assert.match(failureContent, /Children: 1 completed, 1 failed/);
    // No options on either sendMessage call
    assert.equal(sentMessages[0]!.options, undefined);
    assert.equal(sentMessages[1]!.options, undefined);
    // One nudge for the whole burst: the flush's nudge is suppressed and the
    // immediate failure carries it.
    assert.equal(sentUserMessages.length, 1);
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });

    clock.advance(1000);
    assert.equal(sentMessages.length, 2, "the grouped failed run must notify exactly once");
    assert.equal(sentUserMessages.length, 1);
  });

  it("delivers an outer-failed grouped result immediately instead of success batching", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "outer-failed-completed-children",
        agent: "parallel:a+b",
        success: false,
        state: "failed",
        summary: "runner disappeared after children completed",
        results: [
          { agent: "a", status: "completed", summary: "a done" },
          { agent: "b", status: "completed", summary: "b done" },
        ],
      }),
    );

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]!.options, undefined);
    const content = (sentMessages[0]!.message as { content: string }).content;
    assert.match(content, /^Background task failed: \*\*parallel:a\+b\*\*/);
    assert.ok(
      content.indexOf("runner disappeared after children completed") <
        content.indexOf("Children: 2 completed"),
    );
    // Nudge sent (idle, immediate path)
    assert.equal(sentUserMessages.length, 1);
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
    clock.advance(1000);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);
  });

  it("rechecks resumable session existence when a deferred success is delivered", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-deferred-session-"));
    const sessionFile = path.join(resultsDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "session\n", "utf-8");

    try {
      events.emit(
        SUBAGENT_ASYNC_COMPLETE_EVENT,
        completionResult({
          id: "deferred-session-check",
          sessionFile,
        }),
      );
      assert.equal(sentMessages.length, 0);
      fs.unlinkSync(sessionFile);
      clock.advance(150);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]!.options, undefined);
    const content = (sentMessages[0]!.message as { content: string }).content;
    assert.match(content, /Async id: deferred-session-check/);
    assert.doesNotMatch(content, /subagent\({ action: "resume"/);
    // Nudge sent (idle path, deferred batch)
    assert.equal(sentUserMessages.length, 1);
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("groups sibling successes and emits exactly one nudge per flush", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "g-1",
        agent: "alpha",
        summary: "alpha done",
        sessionId: "session-a",
        shareUrl: "https://share/alpha",
        results: [{ agent: "alpha", status: "completed", summary: "alpha done" }],
      }),
    );
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "g-2",
        agent: "beta",
        summary: "beta done",
        sessionId: "session-a",
        shareUrl: "https://share/beta",
        results: [{ agent: "beta", status: "completed", summary: "beta done" }],
      }),
    );
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "g-3",
        agent: "gamma",
        summary: "gamma done",
        sessionId: "session-a",
      }),
    );
    assert.equal(sentMessages.length, 0);
    assert.equal(sentUserMessages.length, 0);

    clock.advance(150);
    // One sendMessage for the grouped batch, one nudge (idle, one per flush — not per subagent)
    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1, "exactly one nudge per flush for grouped completions");
    const groupedMessage = sentMessages[0]!.message as {
      content: string;
      details?: SubagentCompletionBatchDetails;
    };
    const content = groupedMessage.content;
    const groupedDetails = groupedMessage.details;
    assert.ok(groupedDetails, "grouped messages must retain structured completion metadata");
    assert.equal(groupedDetails.schemaVersion, 1);
    assert.equal(groupedDetails.kind, "subagent_completion_batch");
    assert.equal(groupedDetails.batchIndex, 0);
    assert.equal(groupedDetails.batchCount, 1);
    assert.equal(groupedDetails.triggersTurn, true);
    assert.equal(groupedDetails.completions.length, 3);
    assert.deepEqual(
      groupedDetails.completions.map(({ agent, status, asyncId }) => ({ agent, status, asyncId })),
      [
        { agent: "alpha", status: "completed", asyncId: "g-1" },
        { agent: "beta", status: "completed", asyncId: "g-2" },
        { agent: "gamma", status: "completed", asyncId: "g-3" },
      ],
    );
    for (const completion of groupedDetails.completions) {
      assert.deepEqual(Object.keys(completion).sort(), ["agent", "asyncId", "status"]);
      for (const forbiddenField of [
        "taskInfo",
        "resultPreview",
        "resumeTarget",
        "sessionLabel",
        "sessionValue",
        "awaitingSupervisor",
        "_reformatPreview",
      ]) {
        assert.equal(
          forbiddenField in completion,
          false,
          `${forbiddenField} must stay out of batches`,
        );
      }
    }
    assert.match(
      content,
      /^Background tasks completed \(3\): \*\*alpha\*\*, \*\*beta\*\*, \*\*gamma\*\*/,
    );
    assert.match(content, /1\. alpha\nAsync id: g-1\nalpha done\nSession: https:\/\/share\/alpha/);
    assert.match(content, /2\. beta\nAsync id: g-2\nbeta done\nSession: https:\/\/share\/beta/);
    assert.match(content, /3\. gamma\nAsync id: g-3\ngamma done/);
    // No options on sendMessage
    assert.equal(sentMessages[0]!.options, undefined);
    // Nudge once for the whole grouped flush
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("chunks large mixed telemetry batches without dropping order or wakeups", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);
    const telemetryFor = (runId: string) => ({
      schemaVersion: 1,
      run: { id: runId, execution: "async", mode: "single" },
      steps: [{ index: 0, agent: "worker", outcome: { state: "completed" } }],
      provenance: { tlhVersion: "0.41.0", piVersion: "0.85.1", loadedAt: 123 },
      controls: {
        needsAttentionAfterMs: 10_000,
        failedToolAttemptsBeforeAttention: 3,
        notifyOn: ["needs_attention"],
        notifyChannels: ["async"],
      },
    });

    for (let index = 0; index < MAX_GROUPED_ENTRIES + 1; index++) {
      events.emit(
        SUBAGENT_ASYNC_COMPLETE_EVENT,
        completionResult({
          id: `chunk-${index}`,
          agent: `worker-${index}`,
          summary: `worker-${index} done`,
          ...(index === 0 || index === MAX_GROUPED_ENTRIES + 1 - 1
            ? { telemetry: telemetryFor(`telemetry-${index}`) }
            : {}),
          ...(index === 0
            ? {
                prompt: "prompt-secret",
                output: "output-secret",
                cwd: "/private/cwd",
                args: ["args-secret"],
                error: "error-secret",
              }
            : {}),
        }),
      );
    }

    assert.equal(sentMessages.length, 0);
    clock.advance(150);

    assert.equal(sentMessages.length, 2);
    assert.equal(sentUserMessages.length, 1, "all chunks must share one coalesced wakeup");
    const batches = sentMessages.map(
      ({ message }) =>
        message as {
          content: string;
          display: boolean;
          details: SubagentCompletionBatchDetails;
        },
    );
    assert.deepEqual(
      batches.map(({ details }) => ({
        batchId: details.batchId,
        batchIndex: details.batchIndex,
        batchCount: details.batchCount,
        triggersTurn: details.triggersTurn,
      })),
      [
        {
          batchId: batches[0]!.details.batchId,
          batchIndex: 0,
          batchCount: 2,
          triggersTurn: false,
        },
        {
          batchId: batches[0]!.details.batchId,
          batchIndex: 1,
          batchCount: 2,
          triggersTurn: true,
        },
      ],
    );
    // every chunk has display:true and its own prose.
    assert.equal(batches[0]!.display, true);
    assert.equal(batches[1]!.display, true);
    assert.ok(batches[0]!.content.length > 0, "chunk 0 must have prose");
    assert.ok(batches[1]!.content.length > 0, "chunk 1 must have its own prose");
    assert.ok(batches[0]!.content.length <= MAX_COMPLETION_MESSAGE_CHARS);
    assert.ok(batches[1]!.content.length <= MAX_COMPLETION_MESSAGE_CHARS);

    const completions = batches.flatMap(({ details }) => details.completions);
    assert.equal(batches[0]!.details.completions.length, MAX_GROUPED_ENTRIES);
    assert.equal(batches[1]!.details.completions.length, 1);
    assert.deepEqual(
      completions.map(({ agent, asyncId }) => ({ agent, asyncId })),
      Array.from({ length: MAX_GROUPED_ENTRIES + 1 }, (_, index) => ({
        agent: `worker-${index}`,
        asyncId: `chunk-${index}`,
      })),
    );
    assert.equal(completions[0]!.telemetry?.run.id, "telemetry-0");
    assert.equal(completions[MAX_GROUPED_ENTRIES]!.telemetry?.run.id, "telemetry-8");
    assert.equal(completions[1]!.telemetry, undefined, "legacy entries retain absent telemetry");
    const allowedFields = new Set(["agent", "status", "durationMs", "asyncId", "telemetry"]);
    const forbiddenFields = [
      "taskInfo",
      "resultPreview",
      "resumeTarget",
      "sessionLabel",
      "sessionValue",
      "awaitingSupervisor",
      "_reformatPreview",
      "prompt",
      "output",
      "cwd",
      "path",
      "args",
      "error",
    ];
    for (const completion of completions) {
      assert.ok(Object.keys(completion).every((field) => allowedFields.has(field)));
      for (const forbiddenField of forbiddenFields) {
        assert.equal(
          forbiddenField in completion,
          false,
          `${forbiddenField} must stay out of every batch chunk`,
        );
      }
    }
    const serialized = JSON.stringify(batches);
    assert.doesNotMatch(
      serialized,
      /prompt-secret|output-secret|\/private\/cwd|args-secret|error-secret/,
    );
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  for (const entryCount of [MAX_COMPLETION_BATCH_ENTRIES, MAX_COMPLETION_BATCH_ENTRIES + 1]) {
    it(`bounds a ${entryCount}-entry flush into coherent logical batches`, () => {
      const clock = createFakeClock();
      const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);
      for (let index = 0; index < entryCount; index++) {
        events.emit(
          SUBAGENT_ASYNC_COMPLETE_EVENT,
          completionResult({
            id: `boundary-${entryCount}-${index}`,
            agent: `worker-${index}`,
            summary: `worker-${index} done`,
          }),
        );
      }

      clock.advance(150);

      const messages = sentMessages.map(
        ({ message }) =>
          message as {
            content: string;
            display: boolean;
            details: SubagentCompletionBatchDetails;
          },
      );
      const expectedBatchCounts =
        entryCount === MAX_COMPLETION_BATCH_ENTRIES
          ? [MAX_COMPLETION_BATCH_CHUNKS]
          : [MAX_COMPLETION_BATCH_CHUNKS, 1];
      assert.equal(messages.length, Math.ceil(entryCount / MAX_GROUPED_ENTRIES));
      assert.equal(sentUserMessages.length, 1, "one nudge must cover the overall flush");
      // every chunk has display:true with its own prose.
      assert.equal(
        messages.filter(({ display }) => display).length,
        messages.length,
        "every chunk must have display:true",
      );
      assert.equal(messages.filter(({ details }) => details.triggersTurn).length, 1);
      // every chunk has non-empty prose.
      assert.ok(
        messages.every(({ content }) => content.length > 0),
        "every chunk must have non-empty prose",
      );

      const batchIds = [...new Set(messages.map(({ details }) => details.batchId))];
      assert.equal(batchIds.length, expectedBatchCounts.length);
      assert.equal(new Set(batchIds).size, batchIds.length, "logical batches need unique IDs");
      assert.deepEqual(
        batchIds.map((batchId) => {
          const chunks = messages.filter(({ details }) => details.batchId === batchId);
          return {
            batchCount: chunks[0]!.details.batchCount,
            batchIndices: chunks.map(({ details }) => details.batchIndex),
            flushId: chunks[0]!.details.flushId,
            flushIndex: chunks[0]!.details.flushIndex,
            flushCount: chunks[0]!.details.flushCount,
          };
        }),
        expectedBatchCounts.map((batchCount, flushIndex) => ({
          batchCount,
          batchIndices: Array.from({ length: batchCount }, (_, index) => index),
          flushId: messages[0]!.details.flushId,
          flushIndex,
          flushCount: expectedBatchCounts.length,
        })),
      );
      assert.ok(
        messages.every(
          ({ details }) =>
            details.batchCount <= MAX_COMPLETION_BATCH_CHUNKS &&
            isSubagentCompletionBatchDetails(details),
        ),
      );

      const completions = messages.flatMap(({ details }) => details.completions);
      assert.deepEqual(
        completions.map(({ asyncId }) => asyncId),
        Array.from({ length: entryCount }, (_, index) => `boundary-${entryCount}-${index}`),
      );
      assert.equal(messages.at(-1)!.details.triggersTurn, true);
      assert.deepEqual(sentUserMessages[0], {
        content: NUDGE_TEXT,
        options: { deliverAs: "followUp" },
      });
    });
  }

  it("retains the owner batcher so late siblings use the shorter straggler debounce", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages } = createBatchingPi(clock, "session-a");

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({ id: "first-group", agent: "alpha", sessionId: "session-a" }),
    );
    clock.advance(150);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 1);

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({ id: "late-sibling", agent: "beta", sessionId: "session-a" }),
    );
    clock.advance(74);
    assert.equal(
      sentMessages.length,
      1,
      "the straggler must remain held before the shorter debounce expires",
    );
    assert.equal(sentUserMessages.length, 1);
    clock.advance(1);

    assert.equal(sentMessages.length, 2);
    assert.match(
      (sentMessages[1]!.message as { content: string }).content,
      /^Background task completed: \*\*beta\*\*/,
    );
    // No options on sendMessage; nudge sent (idle)
    assert.equal(sentMessages[1]!.options, undefined);
    assert.equal(sentUserMessages.length, 2);
    assert.deepEqual(sentUserMessages[1], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("drops a deferred success batch when its owning session is no longer current", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages, state } = createBatchingPi(clock, "session-a");

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "stale-owner-success",
        agent: "session-a-worker",
        summary: "session A done",
        sessionId: "session-a",
      }),
    );
    assert.equal(sentMessages.length, 0);

    state.currentSessionId = "session-b";
    clock.advance(150);

    assert.equal(
      sentMessages.length,
      0,
      "a stale owner batch must neither send nor trigger a turn in the new session",
    );
    assert.equal(sentUserMessages.length, 0);
  });

  it("flushes a deferred owner success during session shutdown without triggering a new turn or duplicating it later", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages, state, lifecycleHandlers } = createBatchingPi(
      clock,
      "session-a",
    );

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "shutdown-flush-success",
        agent: "session-a-worker",
        summary: "session A done",
        sessionId: "session-a",
      }),
    );
    assert.equal(sentMessages.length, 0);

    lifecycleHandlers.get("session_shutdown")?.({ reason: "switch" });
    assert.equal(sentMessages.length, 1);
    assert.match(
      (sentMessages[0]!.message as { content: string }).content,
      /^Background task completed: \*\*session-a-worker\*\*/,
    );
    // Shutdown flush: triggerTurn:false → no nudge
    assert.equal(sentMessages[0]!.options, undefined);
    assert.equal(sentUserMessages.length, 0, "no nudge must be sent during session shutdown flush");

    state.currentSessionId = "session-b";
    clock.advance(1000);
    assert.equal(
      sentMessages.length,
      1,
      "the shutdown flush must persist exactly once and never re-deliver into the replacement session",
    );
    assert.equal(sentUserMessages.length, 0);
  });

  it("ignores successes from other sessions instead of grouping them", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages } = createBatchingPi(clock, "session-a");

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "s-1",
        agent: "alpha",
        summary: "alpha done",
        sessionId: "session-a",
      }),
    );
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({ id: "s-2", agent: "beta", summary: "beta done", sessionId: "session-b" }),
    );
    clock.advance(150);

    assert.equal(sentMessages.length, 1);
    assert.match(
      (sentMessages[0]!.message as { content: string }).content,
      /^Background task completed: \*\*alpha\*\*/,
    );
    assert.doesNotMatch((sentMessages[0]!.message as { content: string }).content, /beta done/);
    assert.equal(sentUserMessages.length, 1);
  });

  it("does not let another session failure flush held successes", () => {
    const clock = createFakeClock();
    const { events, sentMessages, sentUserMessages } = createBatchingPi(clock, "session-a");

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "held-a-1",
        agent: "alpha",
        summary: "alpha done",
        sessionId: "session-a",
      }),
    );
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({
        id: "fail-b-1",
        agent: "beta",
        success: false,
        summary: "boom",
        exitCode: 1,
        sessionId: "session-b",
      }),
    );
    assert.equal(sentMessages.length, 0);

    clock.advance(150);
    assert.equal(sentMessages.length, 1);
    assert.match(
      (sentMessages[0]!.message as { content: string }).content,
      /^Background task completed: \*\*alpha\*\*/,
    );
    assert.doesNotMatch((sentMessages[0]!.message as { content: string }).content, /boom/);
    assert.equal(sentUserMessages.length, 1);
  });

  // \\ Delivery-hardening tests (ack-after-delivery) \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\

  /**
   * Attach COMPLETION_DELIVERY Symbol metadata to an event payload so that
   * notify.ts reads acknowledgeDelivery from the Symbol key (never plain property).
   * Pass the same eventId for both emissions when testing dedup.
   */
  function withDelivery(
    payload: Record<string, unknown>,
    ack: () => void,
    eventId = `test-eid-${Math.random().toString(36).slice(2)}`,
  ): Record<symbol, unknown> {
    const meta: CompletionDeliveryMetadata = {
      eventId,
      acknowledgeDelivery: ack,
      onAcknowledged: () => {},
    };
    return Object.assign({}, payload, { [COMPLETION_DELIVERY]: meta });
  }

  it("calls acknowledgeDelivery after sendCompletion succeeds on the direct-send path", () => {
    const { events, sentMessages } = createPi();
    let ackCalled = false;
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      withDelivery(
        completionResult({ id: "ack-direct-ok", success: false, sessionId: "session-1" }),
        () => {
          ackCalled = true;
        },
      ),
    );
    assert.equal(sentMessages.length, 1, "failure must deliver immediately");
    assert.equal(ackCalled, true, "acknowledgeDelivery must be called after sendCompletion");
  });

  it("does not call acknowledgeDelivery when sendCompletion throws on the direct-send path", () => {
    const testSessionId = `session-throw-${Date.now()}`;
    let ackCalled = false;
    let sendCalled = 0;
    const throwListeners = new Map<string, Set<(d: unknown) => void>>();
    const throwEvents = {
      on(event: string, h: (d: unknown) => void) {
        const s = throwListeners.get(event) ?? new Set<(d: unknown) => void>();
        s.add(h);
        throwListeners.set(event, s);
        return () => s.delete(h);
      },
      emit(event: string, d: unknown) {
        for (const h of throwListeners.get(event) ?? []) h(d);
      },
    };
    const piThrow = {
      events: throwEvents,
      on(_e: string, _h: (...args: unknown[]) => void) {},
      sendMessage(_m: unknown) {
        sendCalled++;
        throw new Error("simulated send failure");
      },
      sendUserMessage(_c: unknown) {},
    };
    registerSubagentNotify(
      piThrow as never,
      { currentSessionId: testSessionId },
      {
        batchConfig: { enabled: false },
      },
    );
    const resultId = `throw-ack-${Date.now()}`;
    try {
      throwEvents.emit(
        SUBAGENT_ASYNC_COMPLETE_EVENT,
        withDelivery(
          completionResult({ id: resultId, success: false, sessionId: testSessionId }),
          () => {
            ackCalled = true;
          },
        ),
      );
    } catch {
      // sendCompletion threw; swallow to let assertions run
    }
    assert.equal(sendCalled, 1, "sendMessage must be called once");
    assert.equal(ackCalled, false, "ack must not fire when sendCompletion throws");
  });

  it("does not call acknowledgeDelivery when sessionId does not match (session ownership)", () => {
    const { events } = createPi("session-owner");
    let ackCalled = false;
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      withDelivery(
        completionResult({ id: "ack-session-mismatch", sessionId: "session-other" }),
        () => {
          ackCalled = true;
        },
      ),
    );
    assert.equal(ackCalled, false, "ack must not fire for a foreign-session completion");
  });

  it("does not call acknowledgeDelivery when the batcher drops items on session switch", () => {
    const clock = createFakeClock();
    const { events, state } = createBatchingPi(clock, "session-a");
    let ackCalled = false;
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      withDelivery(completionResult({ id: "ack-batcher-drop", sessionId: "session-a" }), () => {
        ackCalled = true;
      }),
    );
    assert.equal(ackCalled, false, "ack must not fire before batch emits");

    // Switch session before the batcher fires.
    state.currentSessionId = "session-b";
    clock.advance(2000);

    assert.equal(
      ackCalled,
      false,
      "ack must not fire when the batcher drops items due to a session switch",
    );
  });

  it("calls acknowledgeDelivery after a lifecycle-flush on session_shutdown (counts as delivered)", () => {
    const clock = createFakeClock();
    const { events, sentMessages, lifecycleHandlers } = createBatchingPi(clock, "session-a");
    let ackCalled = false;
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      withDelivery(completionResult({ id: "ack-shutdown-flush", sessionId: "session-a" }), () => {
        ackCalled = true;
      }),
    );
    assert.equal(ackCalled, false, "ack must not fire before flush");

    lifecycleHandlers.get("session_shutdown")?.({ reason: "switch" });

    assert.equal(sentMessages.length, 1, "lifecycle flush must deliver");
    assert.equal(ackCalled, true, "ack must fire after lifecycle flush delivers");
  });

  it("calls acknowledgeDelivery for already-seen items and does not re-send", () => {
    const { events, sentMessages } = createPi();
    let ackCalled = 0;
    const result = completionResult({ id: "ack-dedup", sessionId: "session-1" });
    const sharedEventId = "ack-dedup-fixed-eid";
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      withDelivery(
        result,
        () => {
          ackCalled++;
        },
        sharedEventId,
      ),
    );
    assert.equal(sentMessages.length, 1, "first emission must deliver");
    assert.equal(ackCalled, 1, "first ack must fire");

    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      withDelivery(
        result,
        () => {
          ackCalled++;
        },
        sharedEventId,
      ),
    );
    assert.equal(sentMessages.length, 1, "second emission must not re-send");
    assert.equal(ackCalled, 2, "second ack must fire to clean up surviving file");
  });

  it("never includes function values in the serialised message details", () => {
    const { events, sentMessages } = createPi();
    let functionFound = false;
    events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      withDelivery(completionResult({ id: "details-no-fn", sessionId: "session-1" }), () => {}),
    );
    assert.equal(sentMessages.length, 1);
    const details = (sentMessages[0]!.message as { details?: unknown }).details;
    const detectFunctions = (value: unknown, depth = 0): void => {
      if (depth > 10) return;
      if (typeof value === "function") {
        functionFound = true;
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const v of Object.values(value as Record<string, unknown>)) {
          detectFunctions(v, depth + 1);
        }
      }
    };
    detectFunctions(details);
    assert.equal(functionFound, false, "message details must not contain function values");
  });

  it("calls acknowledgeDelivery for each item after the batched group fires", () => {
    const clock = createFakeClock();
    const { events, sentMessages } = createBatchingPi(clock, "session-a");
    const ackCounts: Record<string, number> = {};
    for (const id of ["batch-ack-1", "batch-ack-2"]) {
      events.emit(
        SUBAGENT_ASYNC_COMPLETE_EVENT,
        withDelivery(completionResult({ id, sessionId: "session-a" }), () => {
          ackCounts[id] = (ackCounts[id] ?? 0) + 1;
        }),
      );
    }
    assert.equal(sentMessages.length, 0, "held by batcher before debounce");
    assert.deepEqual(ackCounts, {}, "ack must not fire before batcher emits");

    clock.advance(200);

    assert.equal(sentMessages.length, 1, "batch delivered as one message");
    assert.deepEqual(
      ackCounts,
      { "batch-ack-1": 1, "batch-ack-2": 1 },
      "ack must fire once per item after batch sends",
    );
  });

  it("sendMessage ok + nudge throws → item is acked and not re-sent", () => {
    // A failing sendUserMessage (nudge) must NOT prevent acknowledgeDelivery.
    const testSessionId = `session-nudge-throw-${Date.now()}`;
    let ackCalled = false;
    let sendMessageCalled = 0;
    const nudgeListeners = new Map<string, Set<(d: unknown) => void>>();
    const nudgeEvents = {
      on(event: string, h: (d: unknown) => void) {
        const s = nudgeListeners.get(event) ?? new Set<(d: unknown) => void>();
        s.add(h);
        nudgeListeners.set(event, s);
        return () => s.delete(h);
      },
      emit(event: string, d: unknown) {
        for (const h of nudgeListeners.get(event) ?? []) h(d);
      },
    };
    const piNudge = {
      events: nudgeEvents,
      on(_e: string, _h: (...args: unknown[]) => void) {},
      sendMessage(_m: unknown) {
        sendMessageCalled++;
      },
      sendUserMessage(_c: unknown) {
        throw new Error("simulated nudge failure");
      },
    };
    registerSubagentNotify(
      piNudge as never,
      { currentSessionId: testSessionId },
      { batchConfig: { enabled: false } },
    );
    try {
      nudgeEvents.emit(
        SUBAGENT_ASYNC_COMPLETE_EVENT,
        withDelivery(
          completionResult({ id: "nudge-throw-ok", success: false, sessionId: testSessionId }),
          () => {
            ackCalled = true;
          },
        ),
      );
    } catch {
      // nudge threw \ handleComplete should swallow it via try/catch
    }
    assert.equal(sendMessageCalled, 1, "sendMessage must have been called");
    assert.equal(ackCalled, true, "ack must fire even when nudge throws");
  });

  it("chunk-1 send throws → only chunk-0 items acked, chunk-1 item stays recoverable", () => {
    // each chunk has its own prose and is acked independently.
    // When chunk 1's sendMessage throws, only the MAX_GROUPED_ENTRIES items in
    // chunk 0 are acked (their prose was already model-visible). The single item
    // in chunk 1 remains unacked and stays recoverable without re-sending chunk 0.
    const testSessionId = `session-chunk1-throw-${Date.now()}`;
    const chunkAcks: Record<number, boolean> = {};
    const chunk1Listeners = new Map<string, Set<(d: unknown) => void>>();
    const chunk1Events = {
      on(event: string, h: (d: unknown) => void) {
        const s = chunk1Listeners.get(event) ?? new Set<(d: unknown) => void>();
        s.add(h);
        chunk1Listeners.set(event, s);
        return () => s.delete(h);
      },
      emit(event: string, d: unknown) {
        for (const h of chunk1Listeners.get(event) ?? []) h(d);
      },
    };
    let sendCount = 0;
    const pi1 = {
      events: chunk1Events,
      on(_e: string, _h: (...args: unknown[]) => void) {},
      sendMessage(_m: unknown) {
        sendCount++;
        // Throw on 2nd sendMessage (chunk 1 of 2).
        if (sendCount > 1) throw new Error("simulated chunk-1 failure");
      },
      sendUserMessage(_c: unknown) {},
    };
    const clock1 = createFakeClock();
    registerSubagentNotify(
      pi1 as never,
      { currentSessionId: testSessionId },
      {
        batchConfig: { enabled: true, debounceMs: 100, maxWaitMs: 5000 },
        timers: clock1.api,
        now: clock1.now,
      },
    );
    // MAX_GROUPED_ENTRIES + 1 items: chunk 0 has MAX_GROUPED_ENTRIES, chunk 1 has 1.
    const itemCount = MAX_GROUPED_ENTRIES + 1;
    for (let i = 0; i < itemCount; i++) {
      const idx = i;
      chunk1Events.emit(
        SUBAGENT_ASYNC_COMPLETE_EVENT,
        withDelivery(completionResult({ id: `c1-item-${i}`, sessionId: testSessionId }), () => {
          chunkAcks[idx] = true;
        }),
      );
    }
    assert.deepEqual(chunkAcks, {}, "no acks before batcher fires");
    // emitGroupSafe catches the exception so clock.advance returns normally.
    clock1.advance(200);
    assert.equal(sendCount, 2, "sendMessage called for chunk 0 (ok) and chunk 1 (throw)");
    // Chunk 0 items (0..MAX_GROUPED_ENTRIES-1) must all be acked.
    for (let i = 0; i < MAX_GROUPED_ENTRIES; i++) {
      assert.equal(chunkAcks[i], true, `chunk-0 item ${i} must be acked after chunk 0 succeeds`);
    }
    // Chunk 1 item (index MAX_GROUPED_ENTRIES) must NOT be acked — still recoverable.
    assert.equal(
      chunkAcks[MAX_GROUPED_ENTRIES],
      undefined,
      "chunk-1 item must remain unacked and recoverable when chunk 1 throws",
    );
  });

  it("grouped send chunk-0 throws → no items acked, all recovered once", () => {
    const testSessionId = `session-chunk0-throw-${Date.now()}`;
    const chunkAcks: Record<number, boolean> = {};
    const chunk0Listeners = new Map<string, Set<(d: unknown) => void>>();
    const chunk0Events = {
      on(event: string, h: (d: unknown) => void) {
        const s = chunk0Listeners.get(event) ?? new Set<(d: unknown) => void>();
        s.add(h);
        chunk0Listeners.set(event, s);
        return () => s.delete(h);
      },
      emit(event: string, d: unknown) {
        for (const h of chunk0Listeners.get(event) ?? []) h(d);
      },
    };
    let sendCount0 = 0;
    const pi0 = {
      events: chunk0Events,
      on(_e: string, _h: (...args: unknown[]) => void) {},
      sendMessage(_m: unknown) {
        sendCount0++;
        throw new Error("simulated chunk-0 failure");
      },
      sendUserMessage(_c: unknown) {},
    };
    const clock0 = createFakeClock();
    registerSubagentNotify(
      pi0 as never,
      { currentSessionId: testSessionId },
      {
        batchConfig: { enabled: true, debounceMs: 100, maxWaitMs: 5000 },
        timers: clock0.api,
        now: clock0.now,
      },
    );
    const itemCount0 = MAX_GROUPED_ENTRIES + 1;
    for (let i = 0; i < itemCount0; i++) {
      const idx = i;
      chunk0Events.emit(
        SUBAGENT_ASYNC_COMPLETE_EVENT,
        withDelivery(completionResult({ id: `chunk0-item-${i}`, sessionId: testSessionId }), () => {
          chunkAcks[idx] = true;
        }),
      );
    }
    assert.deepEqual(chunkAcks, {}, "no acks before batcher fires");
    // emitGroupSafe catches the exception; clock.advance returns normally.
    clock0.advance(200);
    assert.equal(sendCount0, 1, "sendMessage called once (chunk 0 threw)");
    assert.deepEqual(chunkAcks, {}, "no items acked when chunk 0 throws");
  });

  it("batcher timer exception is caught and does not escape the event loop", async () => {
    // Verify the timer catch using a real timer (not a fake clock).
    // A send failure inside the batcher's setTimeout callback must not escape
    // and crash the parent process.
    const testSessionId = `session-p2-real-timer-${Date.now()}`;
    let sendCalled = 0;
    let p2AckCalled = false;
    const p2Listeners = new Map<string, Set<(d: unknown) => void>>();
    const p2Events = {
      on(event: string, h: (d: unknown) => void) {
        const s = p2Listeners.get(event) ?? new Set<(d: unknown) => void>();
        s.add(h);
        p2Listeners.set(event, s);
        return () => s.delete(h);
      },
      emit(event: string, d: unknown) {
        for (const h of p2Listeners.get(event) ?? []) h(d);
      },
    };
    const p2Pi = {
      events: p2Events,
      on(_e: string, _h: (...args: unknown[]) => void) {},
      sendMessage(_m: unknown) {
        sendCalled++;
        throw new Error("simulated send failure");
      },
      sendUserMessage(_c: unknown) {},
    };
    // Use real timers with a very short debounce.
    registerSubagentNotify(
      p2Pi as never,
      { currentSessionId: testSessionId },
      {
        batchConfig: { enabled: true, debounceMs: 10, maxWaitMs: 100 },
        // No timers override \ uses real setTimeout.
      },
    );
    p2Events.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      withDelivery(completionResult({ id: "p2-real-timer-item", sessionId: testSessionId }), () => {
        // ack should NOT be called since sendMessage throws
        p2AckCalled = true;
      }),
    );
    // Wait for the real timer to fire (and be caught).
    await new Promise((resolve) => setTimeout(resolve, 200));
    // If the catch were missing, an uncaught exception would have crashed the process
    // before reaching here.  Reaching here proves the exception was caught.
    assert.equal(sendCalled, 1, "sendMessage was called inside the batcher timer");
    assert.equal(p2AckCalled, false, "ack must not fire when sendMessage throws");
  });

  it("after batcher timer exception is caught, re-emitting the item delivers it exactly once", async () => {
    // After the catch handles the batcher-timer exception, the item ack is not
    // called.  Re-emitting the event (simulating the orphan-timer coalescer
    // rescan from fix 1) must deliver it exactly once, not duplicate it.
    const testSessionId = `session-p2-recovery-${Date.now()}`;
    let sendCalled = 0;
    let shouldThrow = true;
    let ackCount = 0;
    const p2rListeners = new Map<string, Set<(d: unknown) => void>>();
    const p2rEvents = {
      on(event: string, h: (d: unknown) => void) {
        const s = p2rListeners.get(event) ?? new Set<(d: unknown) => void>();
        s.add(h);
        p2rListeners.set(event, s);
        return () => s.delete(h);
      },
      emit(event: string, d: unknown) {
        for (const h of p2rListeners.get(event) ?? []) h(d);
      },
    };
    const sentContents: string[] = [];
    const p2rPi = {
      events: p2rEvents,
      on(_e: string, _h: (...args: unknown[]) => void) {},
      sendMessage(m: { content?: string }) {
        sendCalled++;
        if (shouldThrow) throw new Error("simulated send failure");
        sentContents.push(m.content ?? "");
      },
      sendUserMessage(_c: unknown) {},
    };
    registerSubagentNotify(
      p2rPi as never,
      { currentSessionId: testSessionId },
      { batchConfig: { enabled: true, debounceMs: 10, maxWaitMs: 100 } },
    );
    const sharedEventId = `p2r-eid-${Date.now()}`;
    const emitItem = () =>
      p2rEvents.emit(
        SUBAGENT_ASYNC_COMPLETE_EVENT,
        withDelivery(
          completionResult({ id: "p2r-item", sessionId: testSessionId }),
          () => {
            ackCount++;
          },
          sharedEventId,
        ),
      );
    emitItem();
    // First batcher fire: sendMessage throws, ack not called.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sendCalled, 1, "first send attempted");
    assert.equal(ackCount, 0, "no ack after throw");
    assert.equal(sentContents.length, 0, "no model-visible content yet");

    // Allow sends; re-emit the same item (simulating coalescer retry).
    shouldThrow = false;
    emitItem();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(ackCount, 1, "item must be acked exactly once on recovery");
    assert.equal(sentContents.length, 1, "exactly one model-visible message after recovery");
    assert.match(
      sentContents[0]!,
      /Background task (completed|failed)/,
      "recovered message must have prose content",
    );
  });

  it("20 completions — each marker appears in exactly one chunk", () => {
    // each chunk has its own prose, so every item's marker appears in
    // exactly ONE chunk's content.  Within that chunk it may appear multiple
    // times (header, body, summary); the guarantee is no item leaks into another
    // chunk's prose.
    const clock = createFakeClock();
    const { events, sentMessages } = createBatchingPi(clock);
    // Markers must not be substrings of each other or of common prose words.
    const markers = Array.from({ length: 20 }, (_, i) => `ZQX${i}ZQXEND`);
    for (let i = 0; i < 20; i++) {
      events.emit(
        SUBAGENT_ASYNC_COMPLETE_EVENT,
        completionResult({
          id: `marker-${i}`,
          agent: markers[i]!,
          summary: `${markers[i]!} summary`,
        }),
      );
    }
    clock.advance(150);

    // 20 items / 8 per chunk = 3 chunks.
    assert.equal(sentMessages.length, 3, "20 items split into 3 chunks");
    const contents = sentMessages.map(({ message }) => (message as { content: string }).content);
    // Every chunk must have non-empty prose.
    for (const c of contents) {
      assert.ok(c.length > 0, "every chunk must have model-visible prose");
    }
    // Each marker must appear in exactly ONE chunk's content.
    for (let i = 0; i < 20; i++) {
      const marker = markers[i]!;
      const chunksContaining = contents.filter((c) => c.includes(marker));
      assert.equal(
        chunksContaining.length,
        1,
        `marker ${marker} must appear in exactly one chunk (got ${chunksContaining.length})`,
      );
    }
    // Partition check: items 0-7 in chunk 0, 8-15 in chunk 1, 16-19 in chunk 2.
    for (let i = 0; i < 8; i++)
      assert.ok(contents[0]!.includes(markers[i]!), `item ${i} must be in chunk 0`);
    for (let i = 8; i < 16; i++)
      assert.ok(contents[1]!.includes(markers[i]!), `item ${i} must be in chunk 1`);
    for (let i = 16; i < 20; i++)
      assert.ok(contents[2]!.includes(markers[i]!), `item ${i} must be in chunk 2`);
  });

  it("MAX_COMPLETION_BATCH_ENTRIES+1 items — each sampled marker in exactly one chunk", () => {
    // Crossing MAX_COMPLETION_BATCH_ENTRIES (512 → 513 items) splits into two
    // logical batches.  Each item's marker must still appear in exactly one chunk.
    const clock = createFakeClock();
    const { events, sentMessages } = createBatchingPi(clock);
    const total = MAX_COMPLETION_BATCH_ENTRIES + 1; // 513
    const markers = Array.from({ length: total }, (_, i) => `ZQXB${i}ZQXEND`);
    for (let i = 0; i < total; i++) {
      events.emit(
        SUBAGENT_ASYNC_COMPLETE_EVENT,
        completionResult({
          id: `bndry-${i}`,
          agent: markers[i]!,
          summary: `${markers[i]!} done`,
        }),
      );
    }
    clock.advance(150);

    // 513 items / 8 per chunk = 65 chunks.
    assert.equal(sentMessages.length, Math.ceil(total / MAX_GROUPED_ENTRIES));
    const contents = sentMessages.map(({ message }) => (message as { content: string }).content);
    // Every chunk must have non-empty prose.
    for (const c of contents) {
      assert.ok(c.length > 0, "every chunk must have model-visible prose");
    }
    // Sample 20 evenly-spaced markers; each must appear in exactly one chunk.
    const sampleIndices = Array.from({ length: 20 }, (_, k) => Math.floor((k * total) / 20));
    for (const idx of sampleIndices) {
      const marker = markers[idx]!;
      const chunksContaining = contents.filter((c) => c.includes(marker));
      assert.equal(
        chunksContaining.length,
        1,
        `marker for item ${idx} must appear in exactly one chunk (got ${chunksContaining.length})`,
      );
    }
    // Explicitly check the items immediately across the logical-batch boundary.
    // Entry MAX_COMPLETION_BATCH_ENTRIES-1 (511) is the last of the first logical
    // batch; entry MAX_COMPLETION_BATCH_ENTRIES (512) is the first of the second.
    const lastOfFirst = MAX_COMPLETION_BATCH_ENTRIES - 1; // 511
    const firstOfSecond = MAX_COMPLETION_BATCH_ENTRIES; // 512
    for (const idx of [lastOfFirst, firstOfSecond]) {
      const marker = markers[idx]!;
      const chunksContaining = contents.filter((c) => c.includes(marker));
      assert.equal(
        chunksContaining.length,
        1,
        `boundary marker for item ${idx} must appear in exactly one chunk (got ${chunksContaining.length})`,
      );
    }
    // Boundary items must NOT be in the same chunk.
    assert.ok(
      !contents
        .filter((c) => c.includes(markers[lastOfFirst]!))
        .some((c) => c.includes(markers[firstOfSecond]!)),
      "items 511 and 512 must be in different chunks (different logical batches)",
    );
  });
});
