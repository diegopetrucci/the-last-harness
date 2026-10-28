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
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { createPi, terminalResult } from "../support/notify-fixtures.ts";

describe("registerSubagentNotify", () => {
  it("delivers a completion carrying a historical awaited marker", () => {
    const { events, sentMessages, wakes } = createPi();

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
    const recovered = sentMessages[0]!.message as {
      content: string;
      details: { resultPreview: string };
    };
    assert.doesNotMatch(recovered.content, /recoverable awaited result/);
    assert.match(recovered.content, /action: "result", id: "awaited-completion"/);
    assert.equal(recovered.details.resultPreview, "recoverable awaited result");
    assert.equal(wakes.length, 1);
  });

  it("uses a fixed shape and fallback summary for an empty completion", () => {
    const { events, sentMessages, wakes } = createPi();

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
      'Background task completed: **worker**\n\nAsync id: notify-empty-1\nFetch output (bounded per child): subagent({ action: "result", id: "notify-empty-1" })',
    );
    assert.equal(message.details.resultPreview, "(no output)");
    assert.equal(wakes.length, 1);
    assert.deepEqual(wakes[0]?.options, { triggerTurn: true });
  });

  it("preserves a multiline summary and task position without exposing raw event fields", () => {
    const { events, sentMessages, wakes } = createPi();
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
    assert.doesNotMatch(message.content, /Done streaming|All clear|Summary:/);
    assert.doesNotMatch(message.content, /raw body|secret status/);
    assert.deepEqual(message.details, {
      agent: "worker",
      status: "completed",
      taskInfo: " (2/3)",
      resultPreview: summary,
      asyncId: "notify-summary-1",
      triggersTurn: true,
    });
    assert.equal(wakes.length, 1);
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
      assert.ok(content.indexOf("Fetch output") < content.indexOf("Revive:"));
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
    assert.equal(topLevelDetails.factsPreview, undefined);

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
    // Runtime-measured facts ride on the child's own line in model-visible content.
    assert.match(
      childDetails.factsPreview ?? "",
      /#1 exit=0, duration=12ms, tokens=\?, tools=1\/0\/2/,
    );
    assert.match(
      formatSingleCompletion(childDetails),
      /^- #0 worker: completed \| #1 exit=0, duration=12ms, tokens=\?, tools=1\/0\/2/m,
    );
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
      const sentMessage = sentHarness.sentMessages[0]!.message as {
        content?: unknown;
        details?: { childRecords?: Array<{ sessionFile?: string; outcome?: unknown }> };
      };
      assert.doesNotMatch(JSON.stringify(sentMessage.content), /private-session|\/private\//);
      // Persisted details keep only the machine lineage record, not paths/previews/facts.
      const { childRecords, ...rest } = sentMessage.details ?? {};
      assert.doesNotMatch(JSON.stringify(rest), /private-session|\/private\//);
      assert.equal(childRecords?.length, 1);
      assert.equal(childRecords?.[0]?.sessionFile, sessionPath);
      assert.deepEqual(childRecords?.[0]?.outcome, { state: "paused" });
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
    const { events, sentMessages, wakes } = createPi("session-owner");

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
    assert.deepEqual(wakes, []);
  });

  it("reads idleness live and sends no wake while streaming", () => {
    const { events, sentMessages, wakes, lifecycleHandlers } = createPi("session-1");
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
    assert.equal(wakes.length, 0);

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
    assert.equal(wakes.length, 1);
  });

  it("delivers failures immediately with the same single shape", () => {
    const { events, sentMessages, wakes } = createPi();
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
      /^Background task failed: \*\*worker\*\*\n\nAsync id: notify-failed-1\n/,
    );
    assert.equal(wakes.length, 1);
  });
});
