import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentNotify, {
  MAX_GROUPED_ENTRIES,
  type SubagentCompletionBatchDetails,
} from "../../src/runs/background/notify.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { buildSubagentRunTelemetry } from "../../src/shared/telemetry.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

function createState(sessionId: string): SubagentState {
  return {
    baseCwd: "/repo",
    currentSessionId: sessionId,
    asyncJobs: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = scaleTestTimeout(1000),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for watcher-to-notify delivery");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createNotifyHarness(): {
  pi: {
    events: {
      on: (event: string, handler: (payload: unknown) => void) => () => void;
      emit: (event: string, data: unknown) => void;
    };
    on: (_event: string, _handler: (...args: unknown[]) => void) => void;
    sendMessage: (message: {
      customType?: string;
      content?: string;
      display?: boolean;
      details?: unknown;
    }) => void;
    sendUserMessage: (content: string, options?: { deliverAs?: string }) => void;
  };
  sent: string[];
  sentMessages: Array<{
    message: {
      customType?: string;
      content?: string;
      display?: boolean;
      details?: unknown;
    };
  }>;
  sentUserMessages: Array<{ content: string; options?: { deliverAs?: string } }>;
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const sent: string[] = [];
  const sentMessages: Array<{
    message: {
      customType?: string;
      content?: string;
      display?: boolean;
      details?: unknown;
    };
  }> = [];
  const sentUserMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
  return {
    pi: {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set();
          handlers.add(handler);
          listeners.set(event, handlers);
          return () => handlers.delete(handler);
        },
        emit(event: string, data: unknown) {
          for (const handler of listeners.get(event) ?? []) handler(data);
        },
      },
      on(_event: string, _handler: (...args: unknown[]) => void) {},
      sendMessage(message: {
        customType?: string;
        content?: string;
        display?: boolean;
        details?: unknown;
      }) {
        sent.push(message.content ?? "");
        sentMessages.push({ message });
      },
      sendUserMessage(content: string, options?: { deliverAs?: string }) {
        sentUserMessages.push({ content, options });
      },
    },
    sent,
    sentMessages,
    sentUserMessages,
  };
}

describe("result watcher to native notify", () => {
  it("does not register or emit the retired result event while notifying the exact owner", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-notify-"));
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const emitted: Array<{ event: string; data: unknown }> = [];
    const sent: Array<{
      message: { customType?: string; content?: string; display?: boolean };
    }> = [];
    const sentUserMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
    const events = {
      on(event: string, handler: (payload: unknown) => void) {
        const handlers = listeners.get(event) ?? new Set();
        handlers.add(handler);
        listeners.set(event, handlers);
        return () => handlers.delete(handler);
      },
      emit(event: string, data: unknown) {
        emitted.push({ event, data });
        for (const handler of listeners.get(event) ?? []) handler(data);
      },
    };
    const pi = {
      events,
      on(_event: string, _handler: (...args: unknown[]) => void) {},
      sendMessage(message: { customType?: string; content?: string; display?: boolean }) {
        sent.push({ message });
      },
      sendUserMessage(content: string, options?: { deliverAs?: string }) {
        sentUserMessages.push({ content, options });
      },
    };
    const state = createState("session-owner");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
    const writeResult = (name: string, data: Record<string, unknown>) => {
      fs.writeFileSync(path.join(resultsDir, name), JSON.stringify(data), "utf-8");
    };

    const singleSession = path.join(resultsDir, "single-session.jsonl");
    const childSession = path.join(resultsDir, "child-9-session.jsonl");
    const pausedChildSession = path.join(resultsDir, "paused-child-session.jsonl");
    fs.writeFileSync(singleSession, "session\n", "utf-8");
    fs.writeFileSync(childSession, "session\n", "utf-8");
    fs.writeFileSync(pausedChildSession, "session\n", "utf-8");
    try {
      writeResult("01-completed.json", {
        id: "completed-event",
        runId: "completed-run",
        agent: "single-worker",
        success: true,
        state: "complete",
        summary: "single done",
        sessionFile: singleSession,
        shareUrl: "https://share/completed-run",
        results: [{ agent: "single-worker", output: "single done", success: true }],
        sessionId: "session-owner",
        intercomTarget: "stale-owner-target",
      });
      writeResult("02-mixed-failed.json", {
        id: "mixed-failed-event",
        runId: "mixed-failed-run",
        agent: "parallel:a+b",
        success: true,
        state: "complete",
        summary: "mixed outer summary",
        results: [
          ...Array.from({ length: 8 }, (_, index) => ({
            agent: `ok-${index}`,
            output: `ok-${index} done`,
            success: true,
          })),
          {
            agent: "late-failure",
            output: "late failure output",
            error: "late failure",
            success: false,
            sessionFile: childSession,
          },
        ],
        sessionId: "session-owner",
        intercomTarget: "stale-owner-target",
      });
      writeResult("03-paused.json", {
        id: "paused",
        agent: "parallel:a+b",
        success: false,
        state: "paused",
        summary: "Paused after interrupt.",
        results: [
          { agent: "a", output: "a done", success: true, exitCode: 0 },
          { agent: "b", output: "b done", success: true, exitCode: 0 },
          { agent: "c", output: "c done", success: true, exitCode: 0 },
          { agent: "d", output: "d done", success: true, exitCode: 0 },
          {
            agent: "e",
            output: "Paused after interrupt.",
            success: false,
            exitCode: 0,
            interrupted: true,
            sessionFile: pausedChildSession,
          },
        ],
        sessionId: "session-owner",
        intercomTarget: "stale-owner-target",
      });
      writeResult("04-missing-session.json", {
        id: "missing-session-event",
        runId: "missing-session-run",
        agent: "missing-session-worker",
        success: true,
        summary: "missing session done",
        sessionFile: path.join(resultsDir, "missing-session.jsonl"),
        sessionId: "session-owner",
      });
      writeResult("05-foreign.json", {
        id: "foreign",
        agent: "foreign-worker",
        success: true,
        summary: "must not deliver",
        sessionId: "session-other",
      });

      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 4);
    } finally {
      watcher.stopResultWatcher();
    }

    assert.equal(sent.length, 4);
    // E′ protocol: sendMessage is called without options (no triggerTurn); nudge comes via sendUserMessage
    assert.equal(
      sent.every(
        (entry) => entry.message.customType === "subagent-notify" && entry.message.display === true,
      ),
      true,
    );
    // Four sendUserMessage nudges (one per completion, all on idle path with batching disabled)
    assert.equal(sentUserMessages.length, 4);
    assert.ok(
      sentUserMessages.every(
        (entry) =>
          entry.content === "[tlh] Background subagent completed — see notification above." &&
          entry.options?.deliverAs === "followUp",
      ),
      "every nudge must use the E\u2032 wake-up text and deliverAs:followUp",
    );
    const contents = sent.map((entry) => entry.message.content ?? "");
    assert.equal(
      contents.some(
        (content) =>
          content.startsWith("Background task completed: **single-worker**") &&
          /Async id: completed-event/.test(content) &&
          /Revive: subagent\({ action: "resume", id: "completed-event", message: "\.\.\." }\)/.test(
            content,
          ) &&
          content.endsWith("Session: https://share/completed-run"),
      ),
      true,
    );
    assert.equal(
      contents.some(
        (content) =>
          content.startsWith("Background task failed: **parallel:a+b**") &&
          /Children: 8 completed, 1 failed/.test(content) &&
          /9\/9\. late-failure — failed/.test(content) &&
          /Revive child: subagent\({ action: "resume", id: "mixed-failed-event", index: 8, message: "\.\.\." }\)/.test(
            content,
          ),
      ),
      true,
    );
    assert.equal(
      contents.some(
        (content) =>
          content.startsWith("Background task paused: **parallel:a+b**") &&
          /Async id: paused/.test(content) &&
          /Revive child: subagent\({ action: "resume", id: "paused", index: 4, message: "\.\.\." }\)/.test(
            content,
          ),
      ),
      true,
    );
    assert.equal(
      contents.some(
        (content) =>
          content.startsWith("Background task completed: **missing-session-worker**") &&
          /Async id: missing-session-event/.test(content) &&
          !/subagent\({ action: "resume"/.test(content),
      ),
      true,
    );
    assert.equal(
      contents.some((content) => content.includes("must not deliver")),
      false,
    );
    assert.equal(
      contents.some((content) => content.includes("stale-owner-target")),
      false,
    );
    assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 4);
    assert.equal(
      emitted.some(
        (entry) =>
          entry.event === "subagent:async-complete" &&
          typeof entry.data === "object" &&
          entry.data !== null &&
          "id" in entry.data &&
          "runId" in entry.data &&
          (entry.data as { id?: unknown }).id === "completed-event" &&
          (entry.data as { runId?: unknown }).runId === "completed-run" &&
          (entry.data as { shareUrl?: unknown }).shareUrl === "https://share/completed-run",
      ),
      true,
    );
    assert.equal(listeners.has("subagent:result-intercom"), false);
    assert.equal(
      emitted.some((entry) => entry.event === "subagent:result-intercom"),
      false,
    );
    assert.equal(fs.existsSync(path.join(resultsDir, "05-foreign.json")), true);
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  it("delivers watcher batches with mixed telemetry in order and wakes once", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-grouped-notify-"));
    const { pi, sentMessages, sent, sentUserMessages } = createNotifyHarness();
    const state = createState("session-owner");
    registerSubagentNotify(pi as never, state);
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
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

    try {
      for (let index = 0; index < MAX_GROUPED_ENTRIES + 1; index++) {
        fs.writeFileSync(
          path.join(resultsDir, `${String(index).padStart(2, "0")}-completion.json`),
          JSON.stringify({
            id: `watcher-${index}`,
            agent: `watcher-worker-${index}`,
            success: true,
            state: "complete",
            summary: `watcher-${index} done`,
            sessionId: "session-owner",
            ...(index === 0 ? { telemetry: telemetryFor("watcher-telemetry-0") } : {}),
            ...(index === 0
              ? {
                  prompt: "prompt-secret",
                  output: "output-secret",
                  cwd: "/private/watcher-cwd",
                  arguments: ["arguments-secret"],
                  error: "error-secret",
                }
              : {}),
          }),
          "utf-8",
        );
      }
      watcher.primeExistingResults();
      await waitUntil(() => sentMessages.length === 2);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }

    assert.equal(sent.length, 2);
    assert.equal(sentUserMessages.length, 1);
    const batches = sentMessages.map(
      ({ message }) => message.details as SubagentCompletionBatchDetails,
    );
    assert.deepEqual(
      batches.map((details) => ({
        batchId: details.batchId,
        batchIndex: details.batchIndex,
        batchCount: details.batchCount,
        triggersTurn: details.triggersTurn,
      })),
      [
        {
          batchId: batches[0]!.batchId,
          batchIndex: 0,
          batchCount: 2,
          triggersTurn: false,
        },
        {
          batchId: batches[0]!.batchId,
          batchIndex: 1,
          batchCount: 2,
          triggersTurn: true,
        },
      ],
    );
    assert.equal(sentMessages[0]!.message.display, true);
    assert.equal(sentMessages[1]!.message.display, false);
    assert.equal(sentMessages[1]!.message.content, "");
    const completions = batches.flatMap((details) => details.completions);
    assert.deepEqual(
      completions.map(({ agent, asyncId }) => ({ agent, asyncId })),
      Array.from({ length: MAX_GROUPED_ENTRIES + 1 }, (_, index) => ({
        agent: `watcher-worker-${index}`,
        asyncId: `watcher-${index}`,
      })),
    );
    assert.equal(completions[0]!.telemetry?.run.id, "watcher-telemetry-0");
    assert.equal(completions[1]!.telemetry, undefined);
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
      "arguments",
      "error",
    ];
    for (const completion of completions) {
      assert.ok(Object.keys(completion).every((field) => allowedFields.has(field)));
      for (const forbiddenField of forbiddenFields) {
        assert.equal(
          forbiddenField in completion,
          false,
          `${forbiddenField} must stay out of every watcher batch chunk`,
        );
      }
    }
    const serialized = JSON.stringify(sentMessages);
    assert.doesNotMatch(
      serialized,
      /prompt-secret|output-secret|\/private\/watcher-cwd|arguments-secret|error-secret/,
    );
    assert.deepEqual(sentUserMessages[0], {
      content: "[tlh] Background subagent completed — see notification above.",
      options: { deliverAs: "followUp" },
    });
  });

  it("notifies an awaiting_supervisor paused result exactly once across repeated scans", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-paused-once-"));
    const resultsDir = path.join(root, "results");
    const asyncDir = path.join(root, "async", "paused-awaiting-supervisor");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(asyncDir, { recursive: true });
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const emitted: Array<{ event: string; data: unknown }> = [];
    const sent: Array<{ message: { content?: string } }> = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set();
          handlers.add(handler);
          listeners.set(event, handlers);
          return () => handlers.delete(handler);
        },
        emit(event: string, data: unknown) {
          emitted.push({ event, data });
          for (const handler of listeners.get(event) ?? []) handler(data);
        },
      },
      on(_event: string, _handler: (...args: unknown[]) => void) {},
      sendMessage(message: { content?: string }) {
        sent.push({ message });
      },
      sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
    };
    const state = createState("session-owner");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
    const pausedSession = path.join(resultsDir, "paused-session.jsonl");
    fs.writeFileSync(pausedSession, "session\n", "utf-8");
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(
        {
          runId: "paused-awaiting-supervisor",
          mode: "single",
          state: "paused",
          startedAt: 100,
          sessionId: "session-owner",
          steps: [
            {
              agent: "worker",
              status: "paused",
              sessionFile: pausedSession,
              pause: { kind: "awaiting_supervisor", pausedAt: 200 },
            },
          ],
          pause: { kind: "awaiting_supervisor", pausedAt: 200 },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const pausedResult = {
      lifecycleArtifactVersion: 1,
      id: "paused-awaiting-supervisor",
      runId: "paused-awaiting-supervisor",
      agent: "worker",
      success: false,
      state: "paused",
      summary: "Paused awaiting supervisor.",
      pause: { kind: "awaiting_supervisor" },
      results: [
        {
          agent: "worker",
          success: false,
          interrupted: true,
          output: "Paused awaiting supervisor.",
          sessionFile: pausedSession,
        },
      ],
      sessionId: "session-owner",
      asyncDir,
    };
    try {
      const resultPath = path.join(resultsDir, "paused-awaiting-supervisor.json");
      fs.writeFileSync(resultPath, JSON.stringify(pausedResult), "utf-8");
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.match(sent[0]!.message.content ?? "", /^Background task paused:/);
      assert.match(sent[0]!.message.content ?? "", /No child process is running\./);
      assert.match(
        sent[0]!.message.content ?? "",
        /Resume unchanged: subagent\(\{ action: "resume", id: "paused-awaiting-supervisor" \}\)/,
      );
      assert.match(
        sent[0]!.message.content ?? "",
        /Resume with guidance: subagent\(\{ action: "resume", id: "paused-awaiting-supervisor", message: "Supervisor replied: \.\.\." \}\)/,
      );
      assert.match(
        sent[0]!.message.content ?? "",
        /Cancel: subagent\(\{ action: "interrupt", id: "paused-awaiting-supervisor" \}\)/,
      );
      assert.doesNotMatch(
        sent[0]!.message.content ?? "",
        new RegExp(pausedSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);

      fs.writeFileSync(resultPath, JSON.stringify(pausedResult), "utf-8");
      watcher.primeExistingResults();
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sent.length, 1);
      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("discards stale paused artifacts when resume wins before the watcher decision", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-resume-first-"));
    const resultsDir = path.join(root, "results");
    const asyncDir = path.join(root, "async", "resume-first");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(asyncDir, { recursive: true });
    const sessionPath = path.join(resultsDir, "resume-first-session.jsonl");
    fs.writeFileSync(sessionPath, "session\n", "utf-8");
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(
        {
          runId: "resume-first",
          mode: "parallel",
          state: "paused",
          startedAt: 100,
          sessionId: "session-owner",
          steps: [
            { agent: "a", status: "continued", sessionFile: sessionPath },
            { agent: "b", status: "paused", pause: { kind: "awaiting_supervisor", pausedAt: 200 } },
          ],
          pause: { kind: "awaiting_supervisor", pausedAt: 200 },
          lifecycle: {
            generation: 3,
            continuationsByIndex: {
              "0": {
                phase: "continued",
                claimToken: "claim-1",
                continuationRunId: "resume-first-child",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const { pi, sent } = createNotifyHarness();
    const state = createState("session-owner");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
    try {
      const resultPath = path.join(resultsDir, "resume-first.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          lifecycleArtifactVersion: 1,
          id: "resume-first",
          runId: "resume-first",
          agent: "parallel:a+b",
          success: false,
          state: "paused",
          summary: "Paused awaiting supervisor.",
          results: [
            {
              agent: "a",
              success: false,
              interrupted: true,
              output: "Paused awaiting supervisor.",
              sessionFile: sessionPath,
            },
            { agent: "b", success: false, interrupted: true, output: "Still paused." },
          ],
          sessionId: "session-owner",
          asyncDir,
        }),
        "utf-8",
      );
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(resultPath));
      assert.deepEqual(sent, []);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("notifies once when the watcher wins before resume continues the paused child", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-resume-second-"));
    const resultsDir = path.join(root, "results");
    const asyncDir = path.join(root, "async", "resume-second");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(asyncDir, { recursive: true });
    const sessionPath = path.join(resultsDir, "resume-second-session.jsonl");
    fs.writeFileSync(sessionPath, "session\n", "utf-8");
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(
        {
          runId: "resume-second",
          mode: "single",
          state: "paused",
          startedAt: 100,
          sessionId: "session-owner",
          steps: [
            {
              agent: "worker",
              status: "paused",
              sessionFile: sessionPath,
              pause: { kind: "awaiting_supervisor", pausedAt: 200 },
            },
          ],
          pause: { kind: "awaiting_supervisor", pausedAt: 200 },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const { pi, sent } = createNotifyHarness();
    const state = createState("session-owner");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
    try {
      const resultPath = path.join(resultsDir, "resume-second.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          lifecycleArtifactVersion: 1,
          id: "resume-second",
          runId: "resume-second",
          agent: "worker",
          success: false,
          state: "paused",
          summary: "Paused awaiting supervisor.",
          results: [
            {
              agent: "worker",
              success: false,
              interrupted: true,
              output: "Paused awaiting supervisor.",
              sessionFile: sessionPath,
            },
          ],
          sessionId: "session-owner",
          asyncDir,
        }),
        "utf-8",
      );
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.match(sent[0] ?? "", /^Background task paused:/);
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "resume-second",
            mode: "single",
            state: "continued",
            startedAt: 100,
            sessionId: "session-owner",
            steps: [{ agent: "worker", status: "continued", sessionFile: sessionPath }],
            lifecycle: {
              generation: 1,
              continuation: {
                phase: "continued",
                claimToken: "claim-2",
                continuationRunId: "resume-second-child",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sent.length, 1);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("discards stale paused artifacts when cancel wins before the watcher decision", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-cancel-first-"));
    const resultsDir = path.join(root, "results");
    const asyncDir = path.join(root, "async", "cancel-first");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(asyncDir, { recursive: true });
    const sessionPath = path.join(resultsDir, "cancel-first-session.jsonl");
    fs.writeFileSync(sessionPath, "session\n", "utf-8");
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(
        {
          runId: "cancel-first",
          mode: "parallel",
          state: "paused",
          startedAt: 100,
          sessionId: "session-owner",
          steps: [
            {
              agent: "a",
              status: "cancelled",
              sessionFile: sessionPath,
              cancel: { summary: "Cancelled", cancelledAt: 250 },
            },
            { agent: "b", status: "paused", pause: { kind: "awaiting_supervisor", pausedAt: 200 } },
          ],
          pause: { kind: "awaiting_supervisor", pausedAt: 200 },
          lifecycle: { generation: 2 },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const { pi, sent } = createNotifyHarness();
    const state = createState("session-owner");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
    try {
      const resultPath = path.join(resultsDir, "cancel-first.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          lifecycleArtifactVersion: 1,
          id: "cancel-first",
          runId: "cancel-first",
          agent: "parallel:a+b",
          success: false,
          state: "paused",
          summary: "Paused awaiting supervisor.",
          results: [
            {
              agent: "a",
              success: false,
              interrupted: true,
              output: "Paused awaiting supervisor.",
              sessionFile: sessionPath,
            },
            { agent: "b", success: false, interrupted: true, output: "Still paused." },
          ],
          sessionId: "session-owner",
          asyncDir,
        }),
        "utf-8",
      );
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(resultPath));
      assert.deepEqual(sent, []);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("notifies once when the watcher wins before cancel removes the paused child", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-cancel-second-"));
    const resultsDir = path.join(root, "results");
    const asyncDir = path.join(root, "async", "cancel-second");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(asyncDir, { recursive: true });
    const sessionPath = path.join(resultsDir, "cancel-second-session.jsonl");
    fs.writeFileSync(sessionPath, "session\n", "utf-8");
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(
        {
          runId: "cancel-second",
          mode: "single",
          state: "paused",
          startedAt: 100,
          sessionId: "session-owner",
          steps: [
            {
              agent: "worker",
              status: "paused",
              sessionFile: sessionPath,
              pause: { kind: "awaiting_supervisor", pausedAt: 200 },
            },
          ],
          pause: { kind: "awaiting_supervisor", pausedAt: 200 },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const { pi, sent } = createNotifyHarness();
    const state = createState("session-owner");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
    try {
      const resultPath = path.join(resultsDir, "cancel-second.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          lifecycleArtifactVersion: 1,
          id: "cancel-second",
          runId: "cancel-second",
          agent: "worker",
          success: false,
          state: "paused",
          summary: "Paused awaiting supervisor.",
          results: [
            {
              agent: "worker",
              success: false,
              interrupted: true,
              output: "Paused awaiting supervisor.",
              sessionFile: sessionPath,
            },
          ],
          sessionId: "session-owner",
          asyncDir,
        }),
        "utf-8",
      );
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.match(sent[0] ?? "", /^Background task paused:/);
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "cancel-second",
            mode: "single",
            state: "cancelled",
            startedAt: 100,
            sessionId: "session-owner",
            steps: [
              {
                agent: "worker",
                status: "cancelled",
                sessionFile: sessionPath,
                cancel: { summary: "Cancelled", cancelledAt: 250 },
              },
            ],
            cancel: { summary: "Cancelled", cancelledAt: 250 },
            lifecycle: { generation: 1 },
          },
          null,
          2,
        ),
        "utf-8",
      );
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sent.length, 1);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries paused artifacts while canonical state is still uncertain", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-pausing-retry-"));
    const resultsDir = path.join(root, "results");
    const asyncDir = path.join(root, "async", "pausing-retry");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(asyncDir, { recursive: true });
    const sessionPath = path.join(resultsDir, "pausing-retry-session.jsonl");
    fs.writeFileSync(sessionPath, "session\n", "utf-8");
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(
        {
          runId: "pausing-retry",
          mode: "single",
          state: "pausing",
          startedAt: 100,
          sessionId: "session-owner",
          steps: [
            {
              agent: "worker",
              status: "pausing",
              sessionFile: sessionPath,
              pause: { kind: "awaiting_supervisor", requestedAt: 150 },
            },
          ],
          pause: { kind: "awaiting_supervisor", requestedAt: 150 },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const { pi, sent } = createNotifyHarness();
    const state = createState("session-owner");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
    try {
      const resultPath = path.join(resultsDir, "pausing-retry.json");
      const pausedResult = {
        lifecycleArtifactVersion: 1,
        id: "pausing-retry",
        runId: "pausing-retry",
        agent: "worker",
        success: false,
        state: "paused",
        summary: "Paused awaiting supervisor.",
        results: [
          {
            agent: "worker",
            success: false,
            interrupted: true,
            output: "Paused awaiting supervisor.",
            sessionFile: sessionPath,
          },
        ],
        sessionId: "session-owner",
        asyncDir,
      };
      fs.writeFileSync(resultPath, JSON.stringify(pausedResult), "utf-8");
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sent.length, 0);
      assert.equal(fs.existsSync(resultPath), true);
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "pausing-retry",
            mode: "single",
            state: "paused",
            startedAt: 100,
            sessionId: "session-owner",
            steps: [
              {
                agent: "worker",
                status: "paused",
                sessionFile: sessionPath,
                pause: { kind: "awaiting_supervisor", pausedAt: 200 },
              },
            ],
            pause: { kind: "awaiting_supervisor", pausedAt: 200 },
          },
          null,
          2,
        ),
        "utf-8",
      );
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries paused artifact consumption after a post-notify unlink failure without duplicating the notification", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-unlink-retry-"));
    const resultsDir = path.join(root, "results");
    const asyncDir = path.join(root, "async", "unlink-retry");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(asyncDir, { recursive: true });
    const sessionPath = path.join(resultsDir, "unlink-retry-session.jsonl");
    fs.writeFileSync(sessionPath, "session\n", "utf-8");
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(
        {
          runId: "unlink-retry",
          mode: "single",
          state: "paused",
          startedAt: 100,
          sessionId: "session-owner",
          steps: [
            {
              agent: "worker",
              status: "paused",
              sessionFile: sessionPath,
              pause: { kind: "awaiting_supervisor", pausedAt: 200 },
            },
          ],
          pause: { kind: "awaiting_supervisor", pausedAt: 200 },
        },
        null,
        2,
      ),
      "utf-8",
    );
    let firstUnlinkFailure = true;
    const fsProxy = {
      existsSync: fs.existsSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      unlinkSync(filePath: fs.PathLike) {
        if (firstUnlinkFailure && String(filePath).endsWith("unlink-retry.json")) {
          firstUnlinkFailure = false;
          throw new Error("simulated unlink failure");
        }
        return fs.unlinkSync(filePath);
      },
      readdirSync: fs.readdirSync.bind(fs),
      mkdirSync: fs.mkdirSync.bind(fs),
      realpathSync: fs.realpathSync.bind(fs),
      watch: fs.watch.bind(fs),
    };
    const { pi, sent } = createNotifyHarness();
    const state = createState("session-owner");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000, { fs: fsProxy });
    try {
      const resultPath = path.join(resultsDir, "unlink-retry.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          lifecycleArtifactVersion: 1,
          id: "unlink-retry",
          runId: "unlink-retry",
          agent: "worker",
          success: false,
          state: "paused",
          summary: "Paused awaiting supervisor.",
          results: [
            {
              agent: "worker",
              success: false,
              interrupted: true,
              output: "Paused awaiting supervisor.",
              sessionFile: sessionPath,
            },
          ],
          sessionId: "session-owner",
          asyncDir,
        }),
        "utf-8",
      );
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.equal(fs.existsSync(resultPath), true);
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(resultPath));
      assert.equal(sent.length, 1);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes a running status telemetry envelope when a terminal result has no telemetry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-telemetry-repair-"));
    const resultsDir = path.join(root, "results");
    const asyncDir = path.join(root, "async", "telemetry-repair");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(asyncDir, { recursive: true });
    const telemetry = buildSubagentRunTelemetry({
      runId: "telemetry-repair",
      execution: "async",
      mode: "single",
      steps: [{ index: 0, agent: "worker", outcome: { state: "running" } }],
      provenance: {
        tlhVersion: "test-tlh",
        piVersion: "test-pi",
        installGeneration: "test-generation",
        loadedAt: 1,
      },
      controls: {
        enabled: true,
        needsAttentionAfterMs: 2_000,
        failedToolAttemptsBeforeAttention: 3,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      },
      startedAt: 1_000,
      outcome: { state: "running" },
    });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: "telemetry-repair",
        mode: "single",
        state: "running",
        startedAt: 1_000,
        lastUpdate: 1_500,
        telemetry,
        steps: [{ agent: "worker", status: "running", startedAt: 1_000 }],
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(resultsDir, "telemetry-repair.json"),
      JSON.stringify({
        id: "telemetry-repair",
        agent: "worker",
        mode: "single",
        success: true,
        state: "complete",
        summary: "done",
        results: [{ agent: "worker", output: "done", success: true }],
        timestamp: 2_000,
        durationMs: 1_000,
      }),
      "utf8",
    );
    try {
      const repaired = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2_000 });
      assert.equal(repaired.repaired, true);
      const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as {
        state: string;
        telemetry: { outcome?: { state?: string }; steps: Array<{ outcome?: { state?: string } }> };
      };
      assert.equal(status.state, "complete");
      assert.equal(status.telemetry.outcome?.state, "completed");
      assert.equal(status.telemetry.steps[0]?.outcome?.state, "completed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers an exact all-completed-child stale repair immediately while success remains batchable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-stale-notify-"));
    const resultsDir = path.join(root, "results");
    const asyncDir = path.join(root, "async", "stale-completed-children");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify(
        {
          runId: "stale-completed-children",
          sessionId: "session-owner",
          mode: "parallel",
          state: "running",
          pid: 424242,
          startedAt: 1_000,
          lastUpdate: 1_500,
          telemetry: buildSubagentRunTelemetry({
            runId: "stale-completed-children",
            execution: "async",
            mode: "parallel",
            steps: [
              { index: 0, agent: "alpha", outcome: { state: "running" } },
              { index: 1, agent: "beta", outcome: { state: "running" } },
            ],
            provenance: {
              tlhVersion: "test-tlh",
              piVersion: "test-pi",
              installGeneration: "test-generation",
              loadedAt: 1,
            },
            controls: {
              enabled: true,
              needsAttentionAfterMs: 2_000,
              failedToolAttemptsBeforeAttention: 3,
              notifyOn: ["needs_attention"],
              notifyChannels: ["event", "async"],
            },
            startedAt: 1_000,
            outcome: { state: "running" },
          }),
          steps: [
            { agent: "alpha", status: "complete", startedAt: 1_000, endedAt: 1_200, exitCode: 0 },
            { agent: "beta", status: "complete", startedAt: 1_000, endedAt: 1_300, exitCode: 0 },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const sent: Array<{ message: { content?: string } }> = [];
    const sentUserMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set();
          handlers.add(handler);
          listeners.set(event, handlers);
          return () => handlers.delete(handler);
        },
        emit(event: string, data: unknown) {
          for (const handler of listeners.get(event) ?? []) handler(data);
        },
      },
      on(_event: string, _handler: (...args: unknown[]) => void) {},
      sendMessage(message: { content?: string }) {
        sent.push({ message });
      },
      sendUserMessage(content: string, options?: { deliverAs?: string }) {
        sentUserMessages.push({ content, options });
      },
    };
    const state = createState("session-owner");
    registerSubagentNotify(pi as never, state, {
      batchConfig: {
        enabled: true,
        debounceMs: 1_000,
        maxWaitMs: 2_000,
        stragglerDebounceMs: 1_000,
        stragglerMaxWaitMs: 2_000,
        stragglerWindowMs: 2_000,
      },
    });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);

    try {
      const successPath = path.join(resultsDir, "01-batched-success.json");
      fs.writeFileSync(
        successPath,
        JSON.stringify({
          id: "batched-success",
          agent: "ordinary-worker",
          success: true,
          state: "complete",
          summary: "ordinary success",
          sessionId: "session-owner",
        }),
        "utf-8",
      );
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(successPath));
      assert.equal(sent.length, 0, "the successful completion should still be held by batching");

      const repaired = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
        now: () => 2_000,
      });
      assert.equal(repaired.repaired, true);
      const repairedPath = path.join(resultsDir, "stale-completed-children.json");
      const repairedResult = JSON.parse(fs.readFileSync(repairedPath, "utf-8"));
      assert.deepEqual(
        repairedResult.results.map((child: { success?: boolean }) => child.success),
        [true, true],
      );
      assert.equal(repairedResult.success, false);
      assert.equal(repairedResult.state, "failed");
      assert.equal(repairedResult.telemetry.outcome.state, "failed");
      assert.deepEqual(
        repairedResult.telemetry.steps.map(
          (step: { outcome?: { state?: string } }) => step.outcome?.state,
        ),
        ["completed", "completed"],
      );
      assert.equal(
        repairedResult.summary,
        "Async runner process 424242 exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.",
      );

      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 2);
      assert.match(
        sent[0]!.message.content ?? "",
        /^Background task completed: \*\*ordinary-worker\*\*/,
      );
      const failure = sent[1]!.message.content ?? "";
      assert.match(failure, /^Background task failed: \*\*alpha\*\*/);
      assert.ok(failure.indexOf(repairedResult.summary) < failure.indexOf("Children: 2 completed"));
      // E′ protocol: no triggerTurn on sendMessage; the failure flushes the
      // held success in the same synchronous burst, so exactly one nudge.
      assert.equal(sentUserMessages.length, 1);
      assert.deepEqual(sentUserMessages[0], {
        content: "[tlh] Background subagent completed — see notification above.",
        options: { deliverAs: "followUp" },
      });
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
