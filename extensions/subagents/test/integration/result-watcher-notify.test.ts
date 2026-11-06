import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentNotify, {
  MAX_GROUPED_ENTRIES,
  type SubagentCompletionBatchDetails,
} from "../../src/runs/background/notify.ts";
import {
  createResultWatcher,
  type ResultWatcherTimers,
} from "../../src/runs/background/result-watcher.ts";
import { getCompletionDelivery } from "../../src/runs/background/completion-dedupe.ts";
import { createFakeClock } from "../support/notify-fixtures.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { buildSubagentRunTelemetry } from "../../src/shared/telemetry.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

function createState(sessionId: string): SubagentState {
  return {
    baseCwd: "/repo",
    currentSessionId: sessionId,
    asyncJobs: new Map(),
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
    // every chunk has display:true with its own prose.
    assert.equal(sentMessages[0]!.message.display, true);
    assert.equal(sentMessages[1]!.message.display, true);
    assert.ok(
      (sentMessages[1]!.message.content ?? "").length > 0,
      "chunk 1 must have its own prose",
    );
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
      statSync: fs.statSync.bind(fs),
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
          if (event === "subagent:async-complete") asyncCompleteCount++;
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
    // Track emitted SUBAGENT_ASYNC_COMPLETE_EVENT count so we can wait for the
    // watcher to process the success file without relying on file deletion.
    // File deletion now happens only after ack (delivery confirmed), so it no
    // longer serves as a proxy for "event emitted and received by notify".
    let asyncCompleteCount = 0;
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
      // Wait for the event to be emitted (not file deletion \ the file now
      // survives until ack which only fires after the batcher sends).
      await waitUntil(() => asyncCompleteCount >= 1);
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

  it("send-throws recovery: file survives and is delivered once on retry scan", async () => {
    // When sendMessage throws:
    //  - acknowledgeDelivery is NOT called, the file is NOT deleted.
    //  - pendingAcks entry is cleared by the orphan timer (TTL=50 ms).
    //  - The next scan re-emits the event; if sendMessage succeeds, ack fires
    //    and the file is unlinked exactly once.
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-send-fail-"));
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    let shouldThrow = true;
    const sent: string[] = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
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
        if (shouldThrow) {
          sent.push("(throw)");
          throw new Error("simulated send failure");
        }
        sent.push(message.content ?? "");
      },
      sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
    };
    const state = createState("session-recovery");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    // Short TTL so the orphan timer fires quickly and clears pendingAcks.
    const watcher = createResultWatcher(pi, state, resultsDir, 50);
    const resultPath = path.join(resultsDir, "recovery.json");
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        id: "recovery-run",
        agent: "worker",
        success: false,
        state: "failed",
        summary: "worker failed",
        results: [{ agent: "worker", output: "worker failed", success: false }],
        sessionId: "session-recovery",
      }),
      "utf-8",
    );
    try {
      watcher.primeExistingResults();
      // Coalescer fires; sendMessage throws → file survives, ack not called.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(resultPath), true, "file must survive send failure");
      assert.equal(sent.filter((s) => s !== "(throw)").length, 0, "no real message sent yet");

      // Orphan timer fires (at ~50 ms): pendingAcks cleared, file still there.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(fs.existsSync(resultPath), true, "file still present after orphan timer");

      // Now allow sends and retry: file should be re-emitted and delivered once.
      shouldThrow = false;
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(resultPath));

      const real = sent.filter((s) => s !== "(throw)");
      assert.equal(real.length, 1, "exactly one delivery after recovery");
      assert.match(real[0]!, /Background task failed/);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("session-switch recovery: file survives and is delivered once when session returns", async () => {
    // Verifies that when the batcher drops items on a session switch, the
    // result file survives (ack never called) and is delivered exactly once
    // when the owning session is re-entered and primeExistingResults is called.
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-switch-recovery-"));
    const clock = createFakeClock();
    const watcherTimers: ResultWatcherTimers = {
      setTimeout(cb: () => void, ms?: number) {
        return clock.api.setTimeout(cb, ms ?? 0);
      },
      clearTimeout(id) {
        clock.api.clearTimeout(id as number);
      },
      setInterval(_cb: () => void, _ms?: number) {
        const h = setInterval(() => {}, 999_999_999);
        clearInterval(h);
        return h;
      },
      clearInterval(_id) {},
    };
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const sent: string[] = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
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
        sent.push(message.content ?? "");
      },
      sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
    };
    const state = createState("session-A");
    registerSubagentNotify(pi as never, state, {
      batchConfig: { enabled: true, debounceMs: 100, maxWaitMs: 5000 },
      timers: clock.api,
      now: clock.now,
    });
    const watcher = createResultWatcher(pi, state, resultsDir, 200, { timers: watcherTimers });
    const resultPath = path.join(resultsDir, "switch-result.json");
    const resultData = {
      id: "switch-run",
      agent: "worker",
      success: true,
      state: "complete",
      summary: "done",
      results: [{ agent: "worker", output: "done", success: true }],
      sessionId: "session-A",
    };
    fs.writeFileSync(resultPath, JSON.stringify(resultData), "utf-8");
    try {
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(fs.existsSync(resultPath), true, "file must survive while batcher holds item");

      state.currentSessionId = "session-B";

      clock.advance(100);
      assert.equal(sent.length, 0, "batcher dropped items on session switch");
      assert.equal(fs.existsSync(resultPath), true, "file survives when batcher drops");

      clock.advance(100);
      assert.equal(fs.existsSync(resultPath), true, "file survives after orphan timer");

      state.currentSessionId = "session-A";
      watcher.clearPendingAcks();
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 0));

      clock.advance(100);

      assert.equal(sent.length, 1, "exactly one delivery after session return");
      assert.match(sent[0]!, /Background task completed/);
      assert.equal(fs.existsSync(resultPath), false, "file cleaned up after delivery");
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("shutdown-reopen recovery: file delivered once after process restart simulation", async () => {
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-restart-recovery-"),
    );
    const resultPath = path.join(resultsDir, "restart-result.json");
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        id: "restart-run",
        agent: "worker",
        success: true,
        state: "complete",
        summary: "restart done",
        results: [{ agent: "worker", output: "restart done", success: true }],
        sessionId: "session-restart",
      }),
      "utf-8",
    );

    const globalStore = globalThis as Record<string, unknown>;
    const savedNotifySeen = globalStore["__pi_subagents_notify_seen__"];
    const savedTrackerSeen = globalStore["__pi_subagents_job_tracker_complete_seen__"];
    delete globalStore["__pi_subagents_notify_seen__"];
    delete globalStore["__pi_subagents_job_tracker_complete_seen__"];

    const sent: string[] = [];
    const { pi } = createNotifyHarness();
    const freshSent = sent;
    (pi as { sendMessage: (m: { content?: string }) => void }).sendMessage = (m: {
      content?: string;
    }) => {
      freshSent.push(m.content ?? "");
    };
    const freshState = createState("session-restart");
    registerSubagentNotify(pi as never, freshState, { batchConfig: { enabled: false } });
    const freshWatcher = createResultWatcher(pi, freshState, resultsDir, 60_000);
    try {
      freshWatcher.primeExistingResults();
      await waitUntil(() => sent.length >= 1 && !fs.existsSync(resultPath));
      assert.equal(sent.length, 1, "exactly one delivery after restart");
      assert.match(sent[0]!, /Background task completed/);
    } finally {
      freshWatcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
      if (savedNotifySeen !== undefined)
        globalStore["__pi_subagents_notify_seen__"] = savedNotifySeen;
      if (savedTrackerSeen !== undefined)
        globalStore["__pi_subagents_job_tracker_complete_seen__"] = savedTrackerSeen;
    }
  });

  it("already-delivered: not re-delivered after reload even when notify seen map cleared", async () => {
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-already-delivered-"),
    );
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const sent: string[] = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
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
        sent.push(message.content ?? "");
      },
      sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
    };
    const state = createState("session-already-delivered");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
    const resultData = {
      id: "already-delivered-run",
      agent: "worker",
      success: true,
      state: "complete",
      summary: "done",
      results: [{ agent: "worker", output: "done", success: true }],
      sessionId: "session-already-delivered",
    };
    const resultPath = path.join(resultsDir, "already-delivered.json");
    try {
      fs.writeFileSync(resultPath, JSON.stringify(resultData), "utf-8");
      watcher.primeExistingResults();
      await waitUntil(() => sent.length >= 1 && !fs.existsSync(resultPath));
      assert.equal(sent.length, 1, "one delivery on first scan");

      // Simulate crash: re-write the file.
      fs.writeFileSync(resultPath, JSON.stringify(resultData), "utf-8");
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(resultPath));
      assert.equal(sent.length, 1, "state.completionSeen prevents re-delivery");

      // Full reload simulation.
      state.completionSeen.clear();
      watcher.clearPendingAcks();
      registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
      fs.writeFileSync(resultPath, JSON.stringify(resultData), "utf-8");
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(resultPath));
      assert.equal(sent.length, 1, "notify globalThis seen prevents re-delivery after reload");
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("does not re-deliver after a session reload when notify already marked the completion seen", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-reload-dedup-"));
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const sent: string[] = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
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
        sent.push(message.content ?? "");
      },
      sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
    };
    const state = createState("session-reload");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);

    const resultData = {
      id: "reload-dedup",
      agent: "worker",
      success: true,
      state: "complete",
      summary: "reload done",
      results: [{ agent: "worker", output: "reload done", success: true }],
      sessionId: "session-reload",
    };
    const resultPath = path.join(resultsDir, "reload-dedup.json");
    try {
      // First delivery.
      fs.writeFileSync(resultPath, JSON.stringify(resultData), "utf-8");
      watcher.primeExistingResults();
      await waitUntil(() => sent.length >= 1 && !fs.existsSync(resultPath));
      assert.equal(sent.length, 1, "first delivery");

      // Simulate crash: re-write file.
      fs.writeFileSync(resultPath, JSON.stringify(resultData), "utf-8");
      // Simulate fresh extension load: clear state and re-register notify.
      state.completionSeen.clear();
      registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
      watcher.primeExistingResults();
      // notify's globalThis seen map has the key → ack fires, file cleaned up, no re-send.
      await waitUntil(() => !fs.existsSync(resultPath));
      assert.equal(
        sent.length,
        1,
        "no re-delivery after reload when notify globalThis seen map holds the key",
      );
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("both listeners (watcher-notify) dedupe by eventId: same eventId not re-delivered on replay", async () => {
    // Verify that replaying a result file with the same eventId produces no
    // additional sends after the first delivery marks the seen map.
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-dedupe-listeners-"),
    );
    const globalStore = globalThis as Record<string, unknown>;
    const savedNotifySeen = globalStore["__pi_subagents_notify_seen__"];
    delete globalStore["__pi_subagents_notify_seen__"];

    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const sent: string[] = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
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
        sent.push(message.content ?? "");
      },
      sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
    };
    const state = createState("session-dedupe");
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });

    const runId = `dedupe-run-${Date.now().toString(36)}`;
    const eventId = `dedupe-eid-${Date.now().toString(36)}`;

    const writeResult = () => {
      fs.writeFileSync(
        path.join(resultsDir, `${runId}.json`),
        JSON.stringify({
          id: runId,
          agent: "worker",
          success: false,
          state: "failed",
          summary: `${runId} summary`,
          results: [{ agent: "worker", output: `${runId} output`, success: false }],
          sessionId: "session-dedupe",
          eventId,
        }),
        "utf-8",
      );
    };

    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
    try {
      writeResult();
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(path.join(resultsDir, `${runId}.json`)));
      assert.equal(sent.length, 1, "notify must deliver the result");

      // Replay: re-write file with the same eventId.
      writeResult();
      watcher.primeExistingResults();
      // completionSeen already holds eventId; watcher cleans up without re-emitting.
      await waitUntil(() => !fs.existsSync(path.join(resultsDir, `${runId}.json`)));
      assert.equal(sent.length, 1, "notify must not re-deliver on replay");
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
      if (savedNotifySeen !== undefined)
        globalStore["__pi_subagents_notify_seen__"] = savedNotifySeen;
      else delete globalStore["__pi_subagents_notify_seen__"];
    }
  });

  it("onAcknowledged fires immediately when registered after ack (production registration order)", async () => {
    // In production, notify is registered before the tracker.
    // When notify's sendMessage fires synchronously inside the event handler,
    // acknowledgeDelivery is called before the tracker's second listener can
    // register its callback via meta.onAcknowledged.
    //
    // This test verifies the fix: after ack has already fired, any subsequent
    // call to onAcknowledged(cb) must invoke cb immediately (once) so
    // late-registered callbacks (project-reference management) are not skipped.
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-ack-order-"));
    const globalStore = globalThis as Record<string, unknown>;
    const savedNotifySeen2 = globalStore["__pi_subagents_notify_seen__"];
    delete globalStore["__pi_subagents_notify_seen__"];

    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const sent: string[] = [];
    let lateAckCallbackFiredCount = 0;
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
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
        sent.push(message.content ?? "");
      },
      sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
    };
    const state = createState("session-ack-order");
    const asyncId = `ack-order-run-${Date.now().toString(36)}`;

    // Production order: notify first, custom consumer second.
    registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });

    // Second listener: registers a callback via onAcknowledged after notify
    // has already called acknowledgeDelivery.
    pi.events.on("subagent:async-complete", (data: unknown) => {
      const meta = getCompletionDelivery(data);
      if (!meta) return;
      meta.onAcknowledged(() => {
        lateAckCallbackFiredCount++;
      });
    });

    const resultFile = path.join(resultsDir, `${asyncId}.json`);
    fs.writeFileSync(
      resultFile,
      JSON.stringify({
        id: asyncId,
        runId: asyncId,
        agent: "ack-order-worker",
        success: false,
        state: "cancelled",
        summary: "cancelled",
        results: [{ agent: "ack-order-worker", output: "", success: false }],
        sessionId: "session-ack-order",
        eventId: `ack-order-event-${Date.now().toString(36)}`,
      }),
      "utf-8",
    );

    const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
    try {
      watcher.primeExistingResults();
      await waitUntil(() => sent.length >= 1 && !fs.existsSync(resultFile));
      assert.equal(sent.length, 1, "notify delivered exactly once");
      assert.equal(
        lateAckCallbackFiredCount,
        1,
        "onAcknowledged callback must fire exactly once even when registered after ack",
      );
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
      if (savedNotifySeen2 !== undefined)
        globalStore["__pi_subagents_notify_seen__"] = savedNotifySeen2;
      else delete globalStore["__pi_subagents_notify_seen__"];
    }
  });

  it("watcher-backed recovery after chunk-1 throw via orphan-timer coalescer (no manual prime)", async () => {
    // After chunk-1 of a grouped send throws:
    //   - chunk-0 items (0..MAX_GROUPED_ENTRIES-1) are acked and their files deleted.
    //   - The chunk-1 file is NOT acked; pendingAcks holds its slot.
    //   - After the orphan timer fires (TTL=80 ms, fix 1), it clears pendingAcks
    //     and calls resultFileCoalescer.schedule(file, 0) \ the production retry.
    //   - The coalescer processes the file again; delivery succeeds.
    //   - chunk-0 files are NOT re-sent (dedupe via completionSeen).
    const sessionId = `session-recovery-${Date.now()}`;
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rw-recovery-"));

    // Write MAX_GROUPED_ENTRIES + 1 result files.
    const totalItems = MAX_GROUPED_ENTRIES + 1;
    const markers = Array.from({ length: totalItems }, (_, i) => `RECOVERY-MARKER-${i}-END`);
    for (let i = 0; i < totalItems; i++) {
      fs.writeFileSync(
        path.join(resultsDir, `result-recovery-${i}.json`),
        JSON.stringify({
          id: `recovery-run-${i}`,
          agent: markers[i]!,
          success: true,
          state: "complete",
          summary: `${markers[i]!} summary`,
          results: [
            {
              agent: markers[i]!,
              output: `${markers[i]!} output`,
              success: true,
              artifactPaths: { outputPath: path.join(resultsDir, `artifact-recovery-${i}.txt`) },
            },
          ],
          sessionId,
        }),
        "utf-8",
      );
      // Write a dummy artifact so sweepStaleResultFiles backup check passes.
      fs.writeFileSync(
        path.join(resultsDir, `artifact-recovery-${i}.txt`),
        `artifact-recovery-${i}`,
        "utf-8",
      );
    }

    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    let sendCount = 0;
    const sentContents: string[] = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
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
        sendCount++;
        // Throw only on the 2nd sendMessage (chunk-1 of the initial grouped send).
        if (sendCount === 2) throw new Error("simulated chunk-1 send failure");
        sentContents.push(message.content ?? "");
      },
      sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
    };

    const state = createState(sessionId);
    // Short batcher window so all files enter the same flush.
    registerSubagentNotify(pi as never, state, {
      batchConfig: { enabled: true, debounceMs: 50, maxWaitMs: 500 },
    });
    // TTL of 80 ms so the orphan timer fires quickly in the test.
    const watcher = createResultWatcher(pi, state, resultsDir, 80);
    try {
      watcher.primeExistingResults();

      // Wait for the initial grouped send: chunk-0 succeeds (sendCount=1),
      // chunk-1 throws (sendCount=2).  After TTL=80ms, orphan timer fires
      // and reschedules the chunk-1 file via the coalescer.
      await waitUntil(() => sentContents.length === 2, scaleTestTimeout(3000));

      // sentContents[0]: chunk-0 prose (MAX_GROUPED_ENTRIES markers).
      // sentContents[1]: chunk-1 retry prose (1 marker), delivered automatically.
      assert.equal(sentContents.length, 2, "exactly two model-visible messages (chunk-0 + retry)");
      assert.equal(sendCount, 3, "3 send calls: chunk-0 ok, chunk-1 throw, chunk-1 retry ok");

      // Chunk-0 markers must appear ONLY in sentContents[0] (no cross-chunk leakage).
      for (let i = 0; i < MAX_GROUPED_ENTRIES; i++) {
        const marker = markers[i]!;
        assert.ok(
          sentContents[0]!.includes(marker),
          `chunk-0 marker ${marker} must appear in chunk-0 content`,
        );
        assert.ok(
          !sentContents[1]!.includes(marker),
          `chunk-0 marker ${marker} must NOT appear in the retry message (no duplicate)`,
        );
      }

      // Chunk-1 marker must appear only in sentContents[1] (the retry message).
      const chunk1Marker = markers[MAX_GROUPED_ENTRIES]!;
      assert.ok(
        sentContents[1]!.includes(chunk1Marker),
        "chunk-1 marker must be in the retry message content",
      );
      assert.ok(
        !sentContents[0]!.includes(chunk1Marker),
        "chunk-1 marker must NOT appear in chunk-0 content",
      );
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });
});
