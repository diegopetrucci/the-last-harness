import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { makeSubagentState } from "../support/helpers.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { readTerminalRecord } from "../../src/runs/background/terminal-record.ts";

type Harness = ReturnType<typeof createHarness>;

function createHarness(root: string) {
  const resultsDir = path.join(root, "results");
  const asyncDir = path.join(root, "async");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(
    path.join(asyncDir, "status.json"),
    JSON.stringify({
      runId: "run-1",
      mode: "single",
      state: "complete",
      startedAt: 1,
      endedAt: 2,
      lastUpdate: 2,
      steps: [],
    }),
  );
  const emitted: unknown[] = [];
  const pi = {
    events: { on: () => () => {}, emit: (_e: string, data: unknown) => emitted.push(data) },
  };
  const state = makeSubagentState({ baseCwd: "/repo", currentSessionId: "session-1" });
  // Native watcher that never delivers an event (the observed missed-event failure).
  const fakeWatcher = Object.assign(new EventEmitter(), { close() {}, unref() {} });
  const intervals: Array<{
    cb: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: boolean;
  }> = [];
  const timeouts: Array<() => void> = [];
  const timers = {
    setTimeout: ((cb: () => void) => {
      timeouts.push(cb);
      return { unref() {} };
    }) as never,
    clearTimeout: (() => {}) as typeof clearTimeout,
    setInterval: ((cb: () => void, delay?: number) => {
      const entry = { cb, delay, cleared: false, unref: false };
      intervals.push(entry);
      return { unref: () => (entry.unref = true), entry };
    }) as never,
    clearInterval: ((handle: { entry?: { cleared: boolean } }) => {
      if (handle?.entry) handle.entry.cleared = true;
    }) as never,
  };
  const fsApi = { ...fs, watch: (() => fakeWatcher) as never };
  const watcher = createResultWatcher(pi, state, resultsDir, { fs: fsApi, timers });
  const resultPath = path.join(resultsDir, "run-1.json");
  const artifact = {
    id: "run-1",
    agent: "worker",
    mode: "single",
    success: true,
    state: "complete",
    summary: "done",
    results: [{ agent: "worker", success: true, output: "full output" }],
    timestamp: 1,
    asyncDir,
    sessionId: "session-1",
  };
  return { resultsDir, asyncDir, resultPath, artifact, emitted, watcher, intervals, timeouts };
}

const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

function withHarness(fn: (h: Harness) => Promise<void>) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-watcher-durable-"));
    const h = createHarness(root);
    const originalError = console.error;
    console.error = () => {};
    try {
      await fn(h);
    } finally {
      console.error = originalError;
      h.watcher.stopResultWatcher();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("result watcher durable-before-unlink and safety rescan", () => {
  it(
    "delivers a results file that produced no fs.watch event via the periodic rescan, once",
    withHarness(async (h) => {
      h.watcher.startResultWatcher();
      assert.equal(h.intervals.length, 1);
      assert.ok(h.intervals[0]!.delay! >= 10_000 && h.intervals[0]!.delay! <= 60_000);
      assert.equal(h.intervals[0]!.unref, true);
      fs.writeFileSync(h.resultPath, JSON.stringify(h.artifact));
      await wait();
      assert.equal(h.emitted.length, 0, "no watch event, nothing delivered yet");
      h.intervals[0]!.cb();
      await wait();
      assert.equal(h.emitted.length, 1);
      assert.equal(fs.existsSync(h.resultPath), false);
      h.intervals[0]!.cb();
      h.intervals[0]!.cb();
      await wait();
      assert.equal(h.emitted.length, 1, "no duplicate notification");
      h.watcher.stopResultWatcher();
      assert.equal(h.intervals[0]!.cleared, true);
    }),
  );

  it(
    "keeps the results file and delivers after recovery when the terminal record cannot be written",
    withHarness(async (h) => {
      // A non-empty directory squatting on the record path makes the atomic write fail.
      const recordPath = path.join(h.asyncDir, "terminal-record.json");
      fs.mkdirSync(recordPath);
      fs.writeFileSync(path.join(recordPath, "block"), "x");
      fs.writeFileSync(h.resultPath, JSON.stringify(h.artifact));
      h.watcher.primeExistingResults();
      await wait();
      assert.equal(h.emitted.length, 0, "must not emit without a durable record");
      assert.equal(fs.existsSync(h.resultPath), true, "results file must be kept");
      assert.ok(h.timeouts.length > 0, "bounded retry scheduled");

      fs.rmSync(recordPath, { recursive: true, force: true });
      h.watcher.primeExistingResults();
      await wait();
      assert.equal(h.emitted.length, 1);
      assert.equal(fs.existsSync(h.resultPath), false);
      const record = readTerminalRecord(h.asyncDir, "run-1");
      assert.equal(record?.children[0]?.output, "full output");
    }),
  );
  for (const [label, mutate] of [
    ["missing asyncDir", (a: Record<string, unknown>) => ({ ...a, asyncDir: "/nonexistent/x" })],
    ["no asyncDir field", (a: Record<string, unknown>) => ({ ...a, asyncDir: undefined })],
    [
      "unsupported envelope",
      (a: Record<string, unknown>) => ({ ...a, results: undefined, state: "bogus" }),
    ],
  ] as const) {
    it(
      `never unlinks the only copy of the output: ${label}`,
      withHarness(async (h) => {
        fs.writeFileSync(h.resultPath, JSON.stringify(mutate(h.artifact)));
        h.watcher.primeExistingResults();
        await wait();
        assert.equal(fs.existsSync(h.resultPath), true, "results file must be kept");
        assert.equal(readTerminalRecord(h.asyncDir, "run-1"), undefined);
        assert.equal(h.emitted.length, 1, "delivered once");
        h.watcher.primeExistingResults();
        await wait();
        assert.equal(h.emitted.length, 1, "retained claim prevents re-emit");
      }),
    );
  }
});
