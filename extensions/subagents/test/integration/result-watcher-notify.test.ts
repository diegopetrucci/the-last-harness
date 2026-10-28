import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { makeSubagentState } from "../support/helpers.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { durableArtifact } from "../support/durable-artifact.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

function createState(sessionId: string): SubagentState {
  return makeSubagentState({
    baseCwd: "/repo",
    currentSessionId: sessionId,
  });
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

function createHarness(sessionId = "session-owner") {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const sent: Array<{ content: string; details?: unknown }> = [];
  // Messages sent with { triggerTurn: true } — the native wake of an idle parent.
  const wakes: Array<{ options?: { triggerTurn?: boolean } }> = [];
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
    sendMessage(
      message: { content?: string; details?: unknown },
      options?: { triggerTurn?: boolean },
    ) {
      sent.push({ content: message.content ?? "", details: message.details });
      if (options?.triggerTurn) wakes.push({ options });
    },
    sendUserMessage() {
      throw new Error("notify must not send a synthetic user message (#470)");
    },
  };
  const state = createState(sessionId);
  registerSubagentNotify(pi as never, state);
  return { pi, state, sent, wakes, emitted };
}

function writeResult(resultsDir: string, file: string, data: Record<string, unknown>): string {
  const resultPath = path.join(resultsDir, file);
  fs.writeFileSync(resultPath, JSON.stringify(durableArtifact(data)), "utf8");
  return resultPath;
}

type PausedFixture = {
  root: string;
  resultsDir: string;
  asyncDir: string;
  resultPath: string;
  sessionPath: string;
  pausedResult: Record<string, unknown>;
};

function createPausedFixture(runId: string, parallel = false): PausedFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tlh-${runId}-`));
  const resultsDir = path.join(root, "results");
  const asyncDir = path.join(root, "async");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(asyncDir, { recursive: true });
  const sessionPath = path.join(resultsDir, `${runId}-session.jsonl`);
  fs.writeFileSync(sessionPath, "session\n", "utf8");
  const steps = parallel
    ? [
        { agent: "a", status: "paused" },
        { agent: "b", status: "paused" },
      ]
    : [{ agent: "worker", status: "paused", sessionFile: sessionPath }];
  fs.writeFileSync(
    path.join(asyncDir, "status.json"),
    JSON.stringify({
      runId,
      mode: parallel ? "parallel" : "single",
      state: "paused",
      startedAt: 100,
      sessionId: "session-owner",
      steps,
      pause: { kind: "awaiting_supervisor", pausedAt: 200 },
    }),
    "utf8",
  );
  const results = parallel
    ? [
        {
          agent: "a",
          success: false,
          interrupted: true,
          output: "Paused awaiting supervisor.",
          sessionFile: sessionPath,
        },
        {
          agent: "b",
          success: false,
          interrupted: true,
          output: "Still paused.",
        },
      ]
    : [
        {
          agent: "worker",
          success: false,
          interrupted: true,
          output: "Paused awaiting supervisor.",
          sessionFile: sessionPath,
        },
      ];
  const pausedResult = {
    lifecycleArtifactVersion: 1,
    id: runId,
    runId,
    agent: parallel ? "parallel:a+b" : "worker",
    success: false,
    state: "paused",
    summary: "Paused awaiting supervisor.",
    pause: { kind: "awaiting_supervisor" },
    results,
    sessionId: "session-owner",
    asyncDir,
  };
  return {
    root,
    resultsDir,
    asyncDir,
    resultPath: path.join(resultsDir, `${runId}.json`),
    sessionPath,
    pausedResult,
  };
}

function writePausedLifecycle(
  fixture: PausedFixture,
  state: string,
  steps: Array<Record<string, unknown>>,
  lifecycle?: Record<string, unknown>,
): void {
  fs.writeFileSync(
    path.join(fixture.asyncDir, "status.json"),
    JSON.stringify({
      runId: fixture.pausedResult.runId,
      mode: steps.length > 1 ? "parallel" : "single",
      state,
      startedAt: 100,
      sessionId: "session-owner",
      steps,
      ...(state === "paused" ? { pause: { kind: "awaiting_supervisor", pausedAt: 200 } } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    }),
    "utf8",
  );
}

describe("result watcher to native notify", () => {
  it("delivers two siblings finishing ten milliseconds apart as two notifications", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-watcher-two-siblings-"));
    const { pi, state, sent, wakes, emitted } = createHarness();
    const watcher = createResultWatcher(pi, state, resultsDir);
    try {
      writeResult(resultsDir, "01-alpha.json", {
        id: "alpha-run",
        runId: "alpha-run",
        agent: "alpha",
        success: true,
        state: "complete",
        summary: "alpha done",
        sessionId: "session-owner",
      });
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);

      await new Promise((resolve) => setTimeout(resolve, 10));
      writeResult(resultsDir, "02-beta.json", {
        id: "beta-run",
        runId: "beta-run",
        agent: "beta",
        success: true,
        state: "complete",
        summary: "beta done",
        sessionId: "session-owner",
      });
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 2);

      assert.match(sent[0]!.content, /^Background task completed: \*\*alpha\*\*/);
      assert.match(sent[1]!.content, /^Background task completed: \*\*beta\*\*/);
      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 2);
      assert.equal(wakes.length, 2);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("uses the watcher as the sole detached delivery owner", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-watcher-owner-"));
    const { pi, state, sent, emitted } = createHarness();
    const watcher = createResultWatcher(pi, state, resultsDir);
    const resultPath = writeResult(resultsDir, "owned.json", {
      id: "owned-run",
      runId: "owned-run",
      agent: "worker",
      success: false,
      state: "failed",
      summary: "failure summary",
      body: "raw body must not leak",
      status: "private status must not leak",
      sessionId: "session-owner",
    });
    try {
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(sent.length, 1, "notify must project the watcher event exactly once");
      assert.doesNotMatch(sent[0]!.content, /failure summary|Summary:/);
      assert.match(sent[0]!.content, /action: "result", id: "/);
      assert.doesNotMatch(sent[0]!.content, /raw body|private status/);
      assert.equal(fs.existsSync(resultPath), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("retains a bounded session share error in the fixed completion shape", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-watcher-share-error-"));
    const { pi, state, sent } = createHarness();
    const watcher = createResultWatcher(pi, state, resultsDir);
    const shareError = `share failed: ${"private-share-detail-".repeat(200)}share-tail`;
    try {
      const resultPath = writeResult(resultsDir, "share-error.json", {
        id: "share-error",
        runId: "share-error",
        agent: "worker",
        success: false,
        state: "failed",
        summary: "share failed after completion",
        shareError,
        sessionId: "session-owner",
      });
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.doesNotMatch(sent[0]!.content, /share failed after completion/);
      assert.match(sent[0]!.content, /Session share error: share failed:/);
      assert.doesNotMatch(sent[0]!.content, /share-tail/);
      assert.equal(fs.existsSync(resultPath), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("keeps the original failed child index in revive guidance", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-watcher-revive-child-"));
    const sessionPath = path.join(resultsDir, "failed-child-session.jsonl");
    fs.writeFileSync(sessionPath, "session\n", "utf8");
    const { pi, state, sent } = createHarness();
    const watcher = createResultWatcher(pi, state, resultsDir);
    try {
      writeResult(resultsDir, "revive-child.json", {
        id: "revive-child",
        runId: "revive-child",
        agent: "parallel:alpha+beta",
        success: true,
        state: "complete",
        summary: "parallel finished with one failed child",
        results: [
          { agent: "alpha", output: "alpha done", success: true },
          {
            agent: "beta",
            output: "beta output",
            error: "beta failed",
            success: false,
            sessionFile: sessionPath,
          },
        ],
        sessionId: "session-owner",
      });
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.match(
        sent[0]!.content,
        /Revive child: subagent\(\{ action: "resume", id: "revive-child", index: 1, message: "\.\.\." \}\)/,
      );
      assert.doesNotMatch(sent[0]!.content, /index: 0, message/);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("delivers a historical awaited-marked artifact as an ordinary detached completion", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-watcher-awaited-recovery-"));
    const runId = "awaited-recovery";
    const { pi, state, sent, wakes, emitted } = createHarness();
    const watcher = createResultWatcher(pi, state, resultsDir);
    try {
      const resultPath = writeResult(resultsDir, "awaited-recovery.json", {
        id: runId,
        runId,
        agent: "worker",
        success: true,
        state: "complete",
        generation: 4,
        awaited: true,
        summary: "recovered awaited result",
        sessionId: "session-owner",
      });
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.doesNotMatch(sent[0]!.content, /recovered awaited result/);
      assert.match(
        (sent[0]!.details as { resultPreview: string }).resultPreview,
        /recovered awaited result/,
      );
      assert.equal(wakes.length, 1);
      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(fs.existsSync(resultPath), false);
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sent.length, 1);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("delivers generation-stamped repair artifacts as detached completions", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-watcher-generation-repair-"));
    const sessionId = "session-owner";
    const cases = [
      {
        label: "reconciler",
        id: "reconciler-repair-generation",
        artifact: {
          id: "reconciler-repair-generation",
          runId: "reconciler-repair-generation",
          agent: "worker",
          mode: "single",
          success: false,
          state: "failed",
          generation: 0,
          summary: "stale runner repaired",
          results: [
            {
              agent: "worker",
              output: "stale runner repaired",
              error: "process exited",
              success: false,
            },
          ],
          exitCode: 1,
          timestamp: 100,
          durationMs: 0,
          asyncDir: path.join(resultsDir, "reconciler-async"),
          sessionId,
        },
      },
      {
        label: "missing-plan",
        id: "missing-plan-generation",
        artifact: {
          lifecycleArtifactVersion: 1,
          id: "missing-plan-generation",
          agent: "subagent",
          mode: "single",
          success: false,
          state: "failed",
          generation: 0,
          summary: "Async runner plan was missing.",
          error: "Async runner plan was missing.",
          results: [],
          exitCode: 1,
          timestamp: 101,
          durationMs: 0,
          asyncDir: path.join(resultsDir, "missing-plan-async"),
          sessionId,
        },
      },
    ] as const;
    const { pi, state, sent, wakes, emitted } = createHarness(sessionId);
    const watcher = createResultWatcher(pi, state, resultsDir);
    try {
      for (const testCase of cases) {
        writeResult(resultsDir, `${testCase.label}.json`, testCase.artifact);
        watcher.primeExistingResults();
      }
      await waitUntil(() => sent.length === cases.length);
      assert.equal(
        emitted.filter((entry) => entry.event === "subagent:async-complete").length,
        cases.length,
      );
      assert.equal(wakes.length, cases.length);
      assert.match(
        (sent[0]!.details as { resultPreview: string }).resultPreview,
        /stale runner repaired/,
      );
      assert.doesNotMatch(sent[0]!.content, /stale runner repaired/);
      assert.match(
        (sent[1]!.details as { resultPreview: string }).resultPreview,
        /Async runner plan was missing/,
      );
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("delivers failure and attention-worthy status without a completion delay", () => {
    const { pi, state, sent, wakes } = createHarness();
    pi.events.emit("subagent:async-complete", {
      id: "failed-immediate",
      agent: "worker",
      success: false,
      state: "failed",
      summary: "failed immediately",
      exitCode: 1,
      sessionId: state.currentSessionId,
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.content, /^Background task failed:/);
    assert.equal(wakes.length, 1);
  });

  it("notifies an awaiting_supervisor paused result exactly once across repeated scans", async () => {
    const fixture = createPausedFixture("paused-awaiting-supervisor");
    const { pi, state, sent, emitted } = createHarness();
    const watcher = createResultWatcher(pi, state, fixture.resultsDir);
    try {
      writeResult(fixture.resultsDir, "paused-awaiting-supervisor.json", fixture.pausedResult);
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.match(sent[0]!.content, /^Background task paused:/);
      assert.match(sent[0]!.content, /No child process is running\./);
      assert.match(sent[0]!.content, /Resume unchanged:/);
      assert.match(sent[0]!.content, /Resume with guidance:/);
      assert.match(sent[0]!.content, /Cancel:/);
      assert.doesNotMatch(sent[0]!.content, /Output artifact:|Session:/);
      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);

      watcher.primeExistingResults();
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sent.length, 1);
      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(fs.existsSync(`${fixture.resultPath}.claim`), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("discards stale paused artifacts when resume wins before the watcher decision", async () => {
    const fixture = createPausedFixture("resume-first", true);
    const { pi, state, sent } = createHarness();
    const watcher = createResultWatcher(pi, state, fixture.resultsDir);
    try {
      writePausedLifecycle(
        fixture,
        "paused",
        [
          { agent: "a", status: "continued", sessionFile: fixture.sessionPath },
          { agent: "b", status: "paused" },
        ],
        {
          generation: 3,
          continuationsByIndex: { "0": { phase: "continued" } },
        },
      );
      writeResult(fixture.resultsDir, "resume-first.json", fixture.pausedResult);
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(fixture.resultPath));
      assert.deepEqual(sent, []);
      assert.equal(fs.existsSync(`${fixture.resultPath}.claim`), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("notifies once when the watcher wins before resume continues the paused child", async () => {
    const fixture = createPausedFixture("resume-second");
    const { pi, state, sent } = createHarness();
    const watcher = createResultWatcher(pi, state, fixture.resultsDir);
    try {
      writeResult(fixture.resultsDir, "resume-second.json", fixture.pausedResult);
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.match(sent[0]!.content, /^Background task paused:/);
      writePausedLifecycle(fixture, "complete", [{ agent: "worker", status: "complete" }], {
        generation: 1,
        continuation: { phase: "continued", continuationRunId: "resume-second-child" },
      });
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sent.length, 1);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("discards stale paused artifacts when cancel wins before the watcher decision", async () => {
    const fixture = createPausedFixture("cancel-first", true);
    const { pi, state, sent } = createHarness();
    const watcher = createResultWatcher(pi, state, fixture.resultsDir);
    try {
      writePausedLifecycle(
        fixture,
        "paused",
        [
          {
            agent: "a",
            status: "cancelled",
            sessionFile: fixture.sessionPath,
            cancel: { summary: "Cancelled", cancelledAt: 250 },
          },
          { agent: "b", status: "paused" },
        ],
        { generation: 2 },
      );
      writeResult(fixture.resultsDir, "cancel-first.json", fixture.pausedResult);
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(fixture.resultPath));
      assert.deepEqual(sent, []);
      assert.equal(fs.existsSync(`${fixture.resultPath}.claim`), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("notifies once when the watcher wins before cancel removes the paused child", async () => {
    const fixture = createPausedFixture("cancel-second");
    const { pi, state, sent } = createHarness();
    const watcher = createResultWatcher(pi, state, fixture.resultsDir);
    try {
      writeResult(fixture.resultsDir, "cancel-second.json", fixture.pausedResult);
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.match(sent[0]!.content, /^Background task paused:/);
      writePausedLifecycle(
        fixture,
        "cancelled",
        [
          {
            agent: "worker",
            status: "cancelled",
            sessionFile: fixture.sessionPath,
            cancel: { summary: "Cancelled", cancelledAt: 250 },
          },
        ],
        { generation: 1 },
      );
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sent.length, 1);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("retries paused artifacts while canonical state is still uncertain", async () => {
    const fixture = createPausedFixture("pausing-retry");
    const { pi, state, sent } = createHarness();
    const watcher = createResultWatcher(pi, state, fixture.resultsDir);
    try {
      writePausedLifecycle(fixture, "pausing", [{ agent: "worker", status: "pausing" }]);
      writeResult(fixture.resultsDir, "pausing-retry.json", fixture.pausedResult);
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sent.length, 0);
      assert.equal(fs.existsSync(fixture.resultPath), true);
      writePausedLifecycle(fixture, "paused", [
        { agent: "worker", status: "paused", sessionFile: fixture.sessionPath },
      ]);
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("diagnoses an injected claim failure and retries without losing delivery", async () => {
    const fixture = createPausedFixture("claim-retry");
    let claimFailures = 1;
    const fsProxy = {
      existsSync: fs.existsSync.bind(fs),
      openSync(filePath: fs.PathLike, flags: string | number, mode?: string | number | null) {
        if (String(filePath) === `${fixture.resultPath}.claim` && claimFailures > 0) {
          claimFailures--;
          const error = new Error("simulated claim permission failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return fs.openSync(filePath, flags, mode);
      },
      closeSync: fs.closeSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      unlinkSync: fs.unlinkSync.bind(fs),
      readdirSync: fs.readdirSync.bind(fs),
      mkdirSync: fs.mkdirSync.bind(fs),
      realpathSync: fs.realpathSync.bind(fs),
      watch: fs.watch.bind(fs),
    };
    const { pi, state, sent } = createHarness();
    const watcher = createResultWatcher(pi, state, fixture.resultsDir, { fs: fsProxy });
    try {
      const result = {
        id: "claim-retry",
        runId: "claim-retry",
        agent: "worker",
        success: true,
        state: "complete",
        summary: "retried delivery",
        sessionId: "session-owner",
      };
      writeResult(fixture.resultsDir, "claim-retry.json", result);
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.equal(claimFailures, 0);
      assert.match(
        (sent[0]!.details as { resultPreview: string }).resultPreview,
        /retried delivery/,
      );
      assert.doesNotMatch(sent[0]!.content, /retried delivery/);
      assert.equal(fs.existsSync(fixture.resultPath), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("retries paused artifact consumption after a post-notify unlink failure without duplicating the notification", async () => {
    const fixture = createPausedFixture("unlink-retry");
    let unlinkFailures = 2;
    const fsProxy = {
      existsSync: fs.existsSync.bind(fs),
      openSync: fs.openSync.bind(fs),
      closeSync: fs.closeSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      unlinkSync(filePath: fs.PathLike) {
        if (String(filePath) === fixture.resultPath && unlinkFailures > 0) {
          unlinkFailures--;
          throw new Error("simulated unlink failure");
        }
        return fs.unlinkSync(filePath);
      },
      readdirSync: fs.readdirSync.bind(fs),
      mkdirSync: fs.mkdirSync.bind(fs),
      realpathSync: fs.realpathSync.bind(fs),
      watch: fs.watch.bind(fs),
    };
    const { pi, state, sent } = createHarness();
    const watcher = createResultWatcher(pi, state, fixture.resultsDir, { fs: fsProxy });
    try {
      writeResult(fixture.resultsDir, "unlink-retry.json", fixture.pausedResult);
      watcher.primeExistingResults();
      await waitUntil(() => sent.length === 1);
      assert.equal(fs.existsSync(fixture.resultPath), true);
      assert.equal(fs.existsSync(`${fixture.resultPath}.claim`), true);
      watcher.primeExistingResults();
      await waitUntil(() => !fs.existsSync(fixture.resultPath));
      assert.equal(sent.length, 1);
      assert.equal(fs.existsSync(`${fixture.resultPath}.claim`), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
