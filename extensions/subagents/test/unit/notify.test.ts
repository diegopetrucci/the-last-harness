import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  MAX_COMPLETION_FACTS_CHARS,
  MAX_DISPLAY_SUMMARY_CHARS,
  buildCompletionDetails,
  formatSingleCompletion,
} from "../../src/runs/background/notify.ts";
import {
  registerAwaitedRun,
  unregisterAwaitedRun,
} from "../../src/runs/background/awaited-run-registry.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type SubagentTerminalResult,
} from "../../src/shared/types.ts";
import { NUDGE_TEXT, createPi } from "../support/notify-fixtures.ts";

function terminalResult(): SubagentTerminalResult {
  return {
    state: "completed",
    facts: {
      attempts: [
        {
          attempt: 1,
          exit: { code: 0, signal: null },
          durationMs: 12,
          providerTokens: { status: "unavailable" },
          requestedToolCalls: { edit: 1, write: 0, bash: 2 },
          workspace: {
            baseline: { status: "unavailable", reason: "not_git_repository" },
            post: { status: "unavailable", reason: "not_git_repository" },
            attribution: "unknown",
          },
        },
      ],
    },
  };
}

describe("registerSubagentNotify", () => {
  it("recovers an awaited marker when no live owner remains", () => {
    const { events, sentMessages, sentUserMessages } = createPi();

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "awaited-completion",
      awaited: true,
      agent: "worker",
      success: true,
      summary: "recoverable awaited result",
      exitCode: 0,
      timestamp: 123,
      sessionId: "session-1",
    });

    assert.equal(sentMessages.length, 1);
    assert.match(
      (sentMessages[0]!.message as { content: string }).content,
      /Summary:\n  recoverable awaited result/,
    );
    assert.equal(sentUserMessages.length, 1);
  });

  it("suppresses a completion generation owned by a live awaited run", () => {
    const { events, sentMessages, sentUserMessages } = createPi();
    const id = `notify-generation-${Date.now().toString(36)}`;
    registerAwaitedRun(
      id,
      () => true,
      2,
      undefined,
      () => true,
    );
    try {
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id,
        agent: "worker",
        success: true,
        summary: "owned generation",
        timestamp: 123,
        generation: 2,
        sessionId: "session-1",
      });
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id,
        agent: "worker",
        success: true,
        summary: "later owned generation",
        timestamp: 124,
        generation: 3,
        sessionId: "session-1",
      });
      assert.deepEqual(sentMessages, []);
      assert.deepEqual(sentUserMessages, []);
    } finally {
      unregisterAwaitedRun(id, 2);
    }
  });

  it("uses a fixed shape and fallback summary for an empty completion", () => {
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

    assert.equal(sentMessages.length, 1);
    const message = sentMessages[0]!.message as {
      content: string;
      details: Record<string, unknown>;
    };
    assert.equal(
      message.content,
      "Background task completed: **worker**\n\nSummary:\n  (no output)\n\nAsync id: notify-empty-1",
    );
    assert.equal(message.details.resultPreview, "(no output)");
    assert.equal(sentUserMessages.length, 1);
    assert.deepEqual(sentUserMessages[0], {
      content: NUDGE_TEXT,
      options: { deliverAs: "followUp" },
    });
  });

  it("preserves a multiline summary and task position without exposing raw event fields", () => {
    const { events, sentMessages, sentUserMessages } = createPi();
    const summary = "Done streaming\nAll clear";

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-summary-1",
      agent: "worker",
      success: true,
      summary,
      exitCode: 0,
      timestamp: 456,
      taskIndex: 1,
      totalTasks: 3,
      body: "raw body must not be serialized",
      status: "secret status must not be serialized",
      sessionId: "session-1",
    });

    const message = sentMessages[0]!.message as { content: string; details: unknown };
    assert.match(message.content, /^Background task completed: \*\*worker\*\* \(2\/3\)/);
    assert.match(message.content, /Summary:\n  Done streaming\n  All clear/);
    assert.doesNotMatch(message.content, /raw body|secret status/);
    assert.deepEqual(message.details, {
      agent: "worker",
      status: "completed",
      taskInfo: " (2/3)",
      resultPreview: summary,
      asyncId: "notify-summary-1",
    });
    assert.equal(sentUserMessages.length, 1);
  });

  it("shows resume guidance only when the session file exists", () => {
    const { events, sentMessages } = createPi();
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-notify-session-"));
    const sessionFile = path.join(resultsDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "session\n", "utf8");

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
      const content = (sentMessages[0]!.message as { content: string }).content;
      assert.ok(content.indexOf("Summary:") < content.indexOf("Revive:"));
      assert.match(
        content,
        /Revive: subagent\(\{ action: "resume", id: "notify-event-1", message: "\.\.\." \}\)/,
      );
      assert.match(
        content,
        new RegExp(`Session file: ${sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("keeps validated child A1c facts while ignoring unvalidated top-level facts", () => {
    const topLevelDetails = buildCompletionDetails({
      id: "notify-top-level-facts",
      agent: "worker",
      success: true,
      summary: "Done",
      timestamp: 100,
      terminalResult: terminalResult(),
    });
    assert.doesNotMatch(formatSingleCompletion(topLevelDetails), /Facts:/);

    const childDetails = buildCompletionDetails({
      id: "notify-child-facts",
      agent: "worker",
      success: true,
      summary: "Done",
      timestamp: 100,
      results: [
        {
          agent: "worker",
          status: "completed",
          summary: "Done",
          artifactPath: "/tmp/worker-output.md",
          terminalResult: terminalResult(),
        },
      ],
    });
    const childNotice = formatSingleCompletion(childDetails);
    assert.ok(childNotice.indexOf("Output artifact:") < childNotice.indexOf("Facts:"));
    assert.match(childNotice, /Facts: #1 exit=0, duration=12ms, tokens=\?, tools=1\/0\/2/);
  });

  it("redacts protected paused lifecycle paths and raw child output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-notify-private-"));
    const sessionPath = path.join(root, "private-session.jsonl");
    fs.writeFileSync(sessionPath, "session\n", "utf8");
    try {
      const details = buildCompletionDetails({
        id: "notify-paused-private",
        agent: "worker",
        success: false,
        state: "paused",
        pause: { kind: "awaiting_supervisor" },
        summary: "Paused at /private/root after pid 43210.",
        timestamp: 100,
        sessionFile: sessionPath,
        results: [
          {
            agent: "worker",
            status: "paused",
            summary: "private child /private/root",
            artifactPath: "/private/artifact.md",
            sessionPath,
          },
        ],
      });
      const content = formatSingleCompletion(details);
      assert.match(content, /^Background task paused:/);
      assert.match(content, /Paused awaiting supervisor\./);
      assert.doesNotMatch(content, /\/private\/|pid 43210|Output artifact:|Session:/);
      assert.match(
        content,
        /Resume unchanged: subagent\(\{ action: "resume", id: "notify-paused-private" \}\)/,
      );
      assert.equal(details.artifactPaths, undefined);
      assert.equal(details.sessionPaths, undefined);
      assert.equal(details.factsPreview, undefined);

      const sentHarness = createPi();
      sentHarness.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: "notify-paused-private",
        agent: "worker",
        success: false,
        state: "paused",
        pause: { kind: "awaiting_supervisor" },
        summary: "Paused at /private/root after pid 43210.",
        timestamp: 100,
        sessionFile: sessionPath,
        results: [
          {
            agent: "worker",
            status: "paused",
            summary: "private child /private/root",
            artifactPath: "/private/artifact.md",
            sessionPath,
          },
        ],
        sessionId: "session-1",
      });
      const sentDetails = sentHarness.sentMessages[0]!.message as { details?: unknown };
      assert.doesNotMatch(JSON.stringify(sentDetails.details), /private-session|\/private\//);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds summaries and facts at their independent display limits", () => {
    const details = buildCompletionDetails({
      id: "notify-bounded",
      agent: "worker",
      success: true,
      summary: "outer",
      timestamp: 100,
      results: [
        {
          agent: "worker",
          status: "completed",
          summary: "x".repeat(10_000),
          terminalResult: {
            state: "completed",
            facts: {
              attempts: Array.from({ length: 64 }, (_, index) => ({
                attempt: index + 1,
                exit: { code: 0, signal: null },
                durationMs: 1,
                providerTokens: { status: "unavailable" },
                requestedToolCalls: { edit: 1, write: 1, bash: 1 },
                workspace: {
                  baseline: { status: "unavailable", reason: "not_git_repository" },
                  post: { status: "unavailable", reason: "not_git_repository" },
                  attribution: "unknown",
                },
              })),
            },
          },
        },
      ],
    });
    assert.ok(details.resultPreview.length <= MAX_DISPLAY_SUMMARY_CHARS);
    assert.ok((details.factsPreview?.length ?? 0) <= MAX_COMPLETION_FACTS_CHARS);
    assert.match(details.resultPreview, /summary truncated/);
    assert.match(details.factsPreview ?? "", /facts truncated/);
  });

  it("ignores completions for another or missing session", () => {
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

  it("reads idleness live and sends no nudge while streaming", () => {
    const { events, sentMessages, sentUserMessages, lifecycleHandlers } = createPi("session-1");
    let idle = false;
    lifecycleHandlers.get("session_start")?.({}, { isIdle: () => idle });

    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-streaming-1",
      agent: "worker",
      success: true,
      summary: "Done while streaming",
      timestamp: 123,
      sessionId: "session-1",
    });
    assert.equal(sentMessages.length, 1);
    assert.equal(sentUserMessages.length, 0);

    idle = true;
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-after-settle-1",
      agent: "worker",
      success: true,
      summary: "Done after settle",
      timestamp: 124,
      sessionId: "session-1",
    });
    assert.equal(sentMessages.length, 2);
    assert.equal(sentUserMessages.length, 1);
  });

  it("delivers failures immediately with the same single shape", () => {
    const { events, sentMessages, sentUserMessages } = createPi();
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "notify-failed-1",
      agent: "worker",
      success: false,
      state: "failed",
      summary: "child failed",
      exitCode: 1,
      timestamp: 123,
      sessionId: "session-1",
    });

    assert.equal(sentMessages.length, 1);
    assert.match(
      (sentMessages[0]!.message as { content: string }).content,
      /^Background task failed: \*\*worker\*\*\n\nSummary:\n  child failed/,
    );
    assert.equal(sentUserMessages.length, 1);
  });
});
