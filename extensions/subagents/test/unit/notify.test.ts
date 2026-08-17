import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentNotify, {
  MAX_COMPLETION_MESSAGE_CHARS,
  MAX_DISPLAY_SUMMARY_CHARS,
  boundedReference,
  buildCompletionDetails,
  formatGroupedCompletion,
  formatSingleCompletion,
  type RegisterSubagentNotifyOptions,
  type SubagentNotifyDetails,
} from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

const NUDGE_TEXT = "[tlh] Background subagent completed — see notification above.";

function createPi(
  currentSessionId = "session-1",
  registerOptions: RegisterSubagentNotifyOptions = {},
) {
  const events = new EventEmitter();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  const lifecycleHandlers = new Map<string, (...args: unknown[]) => void>();
  const pi = {
    events,
    on(event: string, handler: (...args: unknown[]) => void) {
      lifecycleHandlers.set(event, handler);
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(content: unknown, options?: unknown) {
      sentUserMessages.push({ content, options });
    },
  };

  // Formatting-focused tests run with batching disabled so single completions
  // emit synchronously. Batching behavior is covered by the dedicated suite below.
  registerSubagentNotify(
    pi as never,
    { currentSessionId },
    { batchConfig: { enabled: false }, ...registerOptions },
  );

  return { events, sentMessages, sentUserMessages, lifecycleHandlers };
}

function createBatchingPi(
  clock: ReturnType<typeof createFakeClock>,
  currentSessionId = "session-a",
) {
  const events = new EventEmitter();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  const lifecycleHandlers = new Map<string, (...args: unknown[]) => void>();
  const state = { currentSessionId };
  const pi = {
    events,
    on(event: string, handler: (...args: unknown[]) => void) {
      lifecycleHandlers.set(event, handler);
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(content: unknown, options?: unknown) {
      sentUserMessages.push({ content, options });
    },
  };
  registerSubagentNotify(pi as never, state, {
    batchConfig: {
      enabled: true,
      debounceMs: 150,
      maxWaitMs: 1000,
      stragglerDebounceMs: 75,
      stragglerMaxWaitMs: 400,
      stragglerWindowMs: 2000,
    },
    timers: clock.api,
    now: clock.now,
  });
  return { events, sentMessages, sentUserMessages, state, lifecycleHandlers };
}

interface FakeJob {
  id: number;
  fireAt: number;
  handler: () => void;
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const jobs = new Map<number, FakeJob>();
  const api = {
    setTimeout(handler: () => void, delayMs: number): unknown {
      const id = nextId++;
      jobs.set(id, { id, fireAt: now + delayMs, handler });
      return id;
    },
    clearTimeout(handle: unknown): void {
      if (typeof handle === "number") jobs.delete(handle);
    },
  };
  return {
    api,
    now: () => now,
    advance(ms: number): void {
      now += ms;
      const due = [...jobs.values()]
        .filter((job) => job.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      for (const job of due) {
        if (!jobs.has(job.id)) continue;
        jobs.delete(job.id);
        job.handler();
      }
    },
  };
}

function completionResult(overrides: Record<string, unknown> = {}) {
  return {
    id: `notify-${Math.random().toString(36).slice(2)}`,
    agent: "worker",
    success: true,
    summary: "Done",
    exitCode: 0,
    timestamp: 123,
    sessionId: "session-a",
    ...overrides,
  };
}

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
          children: [{ agent: "nested-b", state: "failed" }],
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
    assert.match(
      content,
      /2\/2\. b — failed\nB failed\n\nOutput:\nResult from b\nNested subagents:\n   ↳ nested-b — failed/,
    );
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
    const deepNested = [
      {
        agent: "nested-root",
        state: "complete",
        children: [
          {
            agent: "nested-level-2",
            state: "complete",
            children: [{ agent: "nested-too-deep", state: "complete" }],
          },
        ],
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        agent: `nested-sibling-${index}`,
        state: "complete",
      })),
    ];
    const results = Array.from({ length: 10 }, (_, index) => ({
      agent: `worker-${index}`,
      status: index === 9 ? "failed" : "completed",
      summary: `${index}: ${"x".repeat(4_000)}`,
      ...(index === 0
        ? {
            artifactPath: "/safe/artifacts/worker-0.md",
            sessionPath: "/safe/sessions/worker-0.jsonl",
            intercomTarget: "stale-target-must-not-appear",
            children: deepNested,
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
    assert.match(content, /… \[nested depth limit reached\]/);
    assert.match(content, /… \[additional nested entries omitted\]/);
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
      details?: SubagentNotifyDetails;
    };
    const content = groupedMessage.content;
    assert.equal(groupedMessage.details, undefined, "grouped message shape must remain unchanged");
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
});

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

  it("buildCompletionDetails prioritizes child failure, outer failure, pause, completion, then all-detached failure", () => {
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
    assert.equal(
      buildCompletionDetails({
        ...base,
        results: [
          { agent: "a", status: "completed", summary: "done" },
          { agent: "b", status: "detached", summary: "detached" },
        ],
      }).status,
      "completed",
    );
    assert.equal(
      buildCompletionDetails({
        ...base,
        results: [{ agent: "a", status: "detached", summary: "detached" }],
      }).status,
      "failed",
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
});

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
