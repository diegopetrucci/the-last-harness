/**
 * Race coverage for the detached completion delivery path (watcher -> terminal
 * record -> notify): bursts, parent abort, compaction, session switch, extension
 * reload, and restart recovery. Invariant: every completion is delivered at most
 * once, and an unretrieved result is always discoverable via status/result.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeSubagentState } from "../support/helpers.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import {
  markTerminalRecordRetrieved,
  readTerminalRecord,
} from "../../src/runs/background/terminal-record.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text?: string } | undefined)?.text ?? "";
}

/** Concrete extra-session ids used by the switch scenario. */
const SESSION_A = "session-a";
const SESSION_B = "session-b";

interface Rig {
  state: ReturnType<typeof makeSubagentState>;
  watcher: ReturnType<typeof createResultWatcher>;
  sent: Array<{ runId: string; wake: boolean; content: string }>;
  intervals: Array<() => void>;
  emitWatchEvent: (file: string) => void;
  setIdle: (idle: boolean) => void;
  failNextSends: (count: number) => void;
  stop: () => void;
}

describe("async delivery races", () => {
  let root: string;
  let resultsDir: string;
  let asyncRoot: string;
  let rigs: Rig[];
  let counter = 0;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-delivery-races-"));
    resultsDir = path.join(root, "results");
    asyncRoot = path.join(root, "async");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(asyncRoot, { recursive: true });
    rigs = [];
    originalConsoleError = console.error;
    console.error = () => {};
  });
  afterEach(() => {
    console.error = originalConsoleError;
    for (const rig of rigs) rig.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Yield until every zero-delay coalescer timer scheduled so far has run. */
  const settle = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  /** Resolves once `count` completions were delivered; bounded by a scaled timeout. */
  async function delivered(rig: Rig, count: number): Promise<void> {
    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (rig.sent.length < count) {
      if (Date.now() >= deadline)
        assert.fail(`timed out waiting for ${count} deliveries (have ${rig.sent.length})`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  function createRig(sessionId: string, bus = createBus()): Rig {
    const sent: Rig["sent"] = [];
    let idle = true;
    let failures = 0;
    let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
    const pi = {
      events: bus,
      on(event: string, handler: (event: unknown, ctx: unknown) => void) {
        if (event === "session_start") sessionStart = handler;
      },
      sendMessage(
        message: { content?: string; details?: { asyncId?: string } },
        options?: { triggerTurn?: boolean },
      ) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("stale extension context");
        }
        sent.push({
          runId: message.details?.asyncId ?? "",
          wake: options?.triggerTurn === true,
          content: message.content ?? "",
        });
      },
    };
    const state = makeSubagentState({ baseCwd: "/repo", currentSessionId: sessionId });
    registerSubagentNotify(pi as never, state);
    // Notify reads idleness live from the context captured at session_start.
    sessionStart?.({}, { isIdle: () => idle });
    const fakeWatcher = Object.assign(new EventEmitter(), { close() {}, unref() {} });
    let watchCallback: ((event: string, file: string) => void) | undefined;
    const intervals: Array<() => void> = [];
    const timers = {
      setTimeout: (() => ({ unref() {} })) as never,
      clearTimeout: (() => {}) as typeof clearTimeout,
      setInterval: ((cb: () => void) => {
        intervals.push(cb);
        return { unref() {} };
      }) as never,
      clearInterval: (() => {}) as never,
    };
    const fsApi = {
      ...fs,
      watch: ((_dir: string, cb: (event: string, file: string) => void) => {
        watchCallback = cb;
        return fakeWatcher;
      }) as never,
    };
    const watcher = createResultWatcher(pi as never, state, resultsDir, { fs: fsApi, timers });
    watcher.startResultWatcher();
    const rig: Rig = {
      state,
      watcher,
      sent,
      intervals,
      emitWatchEvent: (file) => watchCallback?.("rename", file),
      setIdle: (value) => {
        idle = value;
      },
      failNextSends: (count) => {
        failures = count;
      },
      stop: () => watcher.stopResultWatcher(),
    };
    rigs.push(rig);
    return rig;
  }
  function createBus() {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    return {
      on(event: string, handler: (payload: unknown) => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
        return () => set.delete(handler);
      },
      // Mirrors Pi's event bus: a throwing listener never breaks the emitter.
      emit(event: string, data: unknown) {
        for (const handler of listeners.get(event) ?? []) {
          try {
            handler(data);
          } catch (error) {
            console.error("listener failed", error);
          }
        }
      },
    };
  }

  /** Writes a finalized run (status + results artifact), as the detached runner does. */
  function finishRun(sessionId: string, children = 1): { runId: string; asyncDir: string } {
    counter += 1;
    const runId = `race-${counter}`;
    const asyncDir = path.join(asyncRoot, runId);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId,
        mode: children > 1 ? "parallel" : "single",
        state: "complete",
        sessionId,
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        steps: Array.from({ length: children }, () => ({ agent: "worker", status: "complete" })),
      }),
    );
    fs.writeFileSync(
      path.join(resultsDir, `${runId}.json`),
      JSON.stringify({
        id: runId,
        agent: "worker",
        mode: children > 1 ? "parallel" : "single",
        success: true,
        state: "complete",
        summary: "done",
        results: Array.from({ length: children }, (_, i) => ({
          agent: "worker",
          success: true,
          output: `output of ${runId}#${i}`,
        })),
        timestamp: 200,
        asyncDir,
        sessionId,
      }),
    );
    return { runId, asyncDir };
  }

  const statusText = (sessionId: string) =>
    textOf(
      inspectSubagentStatus(
        {},
        { asyncDirRoot: asyncRoot, resultsDir, state: { currentSessionId: sessionId } as never },
      ),
    );

  const resultsOnDisk = () => fs.readdirSync(resultsDir).filter((f) => f.endsWith(".json"));

  it("delivers a burst of simultaneous completions exactly once each, across racing triggers", async () => {
    const rig = createRig(SESSION_A);
    const runs = Array.from({ length: 24 }, () => finishRun(SESSION_A, 2));
    // Every trigger races: native events, startup scan, the periodic safety rescan.
    for (const { runId } of runs) rig.emitWatchEvent(`${runId}.json`);
    rig.watcher.primeExistingResults();
    rig.intervals[0]?.();
    rig.watcher.primeExistingResults();
    await delivered(rig, runs.length);
    await settle();
    rig.intervals[0]?.();
    rig.watcher.primeExistingResults();
    await settle();

    assert.deepEqual(rig.sent.map((s) => s.runId).sort(), runs.map((r) => r.runId).sort());
    assert.equal(resultsOnDisk().length, 0);
    for (const { runId, asyncDir } of runs) {
      assert.equal(readTerminalRecord(asyncDir, runId)?.children.length, 2, "durable record");
    }
    // Notifications never carry child-authored output; it is fetched via `result`.
    for (const entry of rig.sent) assert.doesNotMatch(entry.content, /output of race-/);
  });

  it("keeps unretrieved burst results discoverable and retrieval removes them from status", async () => {
    const rig = createRig(SESSION_A);
    const runs = Array.from({ length: 5 }, () => finishRun(SESSION_A));
    rig.watcher.primeExistingResults();
    await delivered(rig, runs.length);
    for (const { runId } of runs) assert.match(statusText(SESSION_A), new RegExp(runId));

    const [first] = runs;
    const record = readTerminalRecord(first!.asyncDir, first!.runId)!;
    assert.equal(record.children[0]?.output, `output of ${first!.runId}#0`);
    markTerminalRecordRetrieved(first!.asyncDir, record);
    assert.doesNotMatch(statusText(SESSION_A), new RegExp(`- ${first!.runId} `));
    for (const { runId } of runs.slice(1)) assert.match(statusText(SESSION_A), new RegExp(runId));
  });

  it("delivers once as a steer, not a wake, while the parent is mid-turn or aborting", async () => {
    const rig = createRig(SESSION_A);
    rig.setIdle(false);
    const busy = finishRun(SESSION_A);
    rig.watcher.primeExistingResults();
    await delivered(rig, 1);
    rig.setIdle(true);
    const idle = finishRun(SESSION_A);
    rig.watcher.primeExistingResults();
    await delivered(rig, 2);
    await settle();
    assert.equal(rig.sent.length, 2);
    assert.deepEqual(
      rig.sent.map((s) => [s.runId, s.wake]),
      [
        [busy.runId, false],
        [idle.runId, true],
      ],
    );
  });

  it("does not duplicate or lose a completion when the parent send fails mid-delivery", async () => {
    const rig = createRig(SESSION_A);
    rig.failNextSends(1);
    const runs = [finishRun(SESSION_A), finishRun(SESSION_A)];
    rig.watcher.primeExistingResults();
    await delivered(rig, 1);
    await settle();
    rig.intervals[0]?.();
    rig.watcher.primeExistingResults();
    await settle();

    // One send was lost to the stale context and is never replayed as a duplicate.
    assert.equal(rig.sent.length, 1);
    // Neither run is lost: both durable records stay discoverable and retrievable.
    const status = statusText(SESSION_A);
    for (const { runId, asyncDir } of runs) {
      assert.match(status, new RegExp(runId));
      assert.equal(
        readTerminalRecord(asyncDir, runId)?.children[0]?.output,
        `output of ${runId}#0`,
      );
    }
  });

  it("survives compaction: no redelivery and results stay retrievable after message history is dropped", async () => {
    const rig = createRig(SESSION_A);
    const { runId, asyncDir } = finishRun(SESSION_A);
    rig.watcher.primeExistingResults();
    await delivered(rig, 1);
    // Compaction drops the delivered custom message from model context; state is untouched.
    rig.sent.length = 0;
    rig.intervals[0]?.();
    rig.watcher.primeExistingResults();
    await settle();
    assert.equal(rig.sent.length, 0, "compaction never replays a delivered completion");
    assert.match(statusText(SESSION_A), new RegExp(runId));
    assert.equal(readTerminalRecord(asyncDir, runId)?.children[0]?.status, "completed");
  });

  it("holds a foreign-session result across a session switch and delivers it once on return", async () => {
    const rig = createRig(SESSION_A);
    const { runId } = finishRun(SESSION_A);
    rig.state.currentSessionId = SESSION_B; // session switch before the completion lands
    rig.emitWatchEvent(`${runId}.json`);
    rig.watcher.primeExistingResults();
    await settle();
    assert.equal(rig.sent.length, 0);
    assert.deepEqual(resultsOnDisk(), [`${runId}.json`], "not consumed by the wrong session");
    assert.doesNotMatch(statusText(SESSION_B), new RegExp(runId));

    rig.state.currentSessionId = SESSION_A; // switch back; session_start rescans
    rig.watcher.primeExistingResults();
    rig.watcher.primeExistingResults();
    await delivered(rig, 1);
    await settle();
    assert.equal(rig.sent.length, 1);
    assert.match(statusText(SESSION_A), new RegExp(runId));
  });

  it("delivers once when a reloaded extension instance overlaps the old watcher", async () => {
    const bus = createBus();
    const oldRig = createRig(SESSION_A, bus);
    // Reload: a fresh instance registers notify (replacing the old subscription) and watches
    // the same results dir before the old watcher is torn down.
    const newRig = createRig(SESSION_A, bus);
    const runs = Array.from({ length: 6 }, () => finishRun(SESSION_A));
    oldRig.watcher.primeExistingResults();
    newRig.watcher.primeExistingResults();
    for (const { runId } of runs) {
      oldRig.emitWatchEvent(`${runId}.json`);
      newRig.emitWatchEvent(`${runId}.json`);
    }
    await delivered(newRig, runs.length);
    await settle();
    const total = oldRig.sent.length + newRig.sent.length;
    assert.equal(total, runs.length, "each completion reaches exactly one live listener");
    assert.equal(oldRig.sent.length, 0, "the replaced notify subscription stays detached");
    oldRig.stop();
    newRig.watcher.primeExistingResults();
    await settle();
    assert.equal(newRig.sent.length, runs.length);
  });

  it("recovers results written while the extension was down, once, and never replays delivered ones", async () => {
    const before = createRig(SESSION_A);
    const delivered1 = finishRun(SESSION_A);
    before.watcher.primeExistingResults();
    await delivered(before, 1);
    before.stop();

    // Process restart: completions land with no watcher alive.
    const missed = Array.from({ length: 4 }, () => finishRun(SESSION_A));
    const after = createRig(SESSION_A);
    after.watcher.primeExistingResults(); // session_start / startup scan
    after.intervals[0]?.();
    await delivered(after, missed.length);
    await settle();
    assert.deepEqual(after.sent.map((s) => s.runId).sort(), missed.map((m) => m.runId).sort());
    assert.ok(!after.sent.some((s) => s.runId === delivered1.runId));
    for (const { runId } of [delivered1, ...missed]) {
      assert.match(statusText(SESSION_A), new RegExp(runId), "unretrieved results discoverable");
    }
  });

  it("keeps the results file and delivers after restart when persistence failed before the crash", async () => {
    const { runId, asyncDir } = finishRun(SESSION_A);
    const recordPath = path.join(asyncDir, "terminal-record.json");
    fs.mkdirSync(recordPath); // squatter: durable write fails, so nothing may be consumed
    fs.writeFileSync(path.join(recordPath, "block"), "x");
    const crashed = createRig(SESSION_A);
    crashed.watcher.primeExistingResults();
    await settle();
    assert.equal(crashed.sent.length, 0);
    assert.deepEqual(resultsOnDisk(), [`${runId}.json`]);
    crashed.stop();

    fs.rmSync(recordPath, { recursive: true, force: true });
    const restarted = createRig(SESSION_A);
    restarted.watcher.primeExistingResults();
    await delivered(restarted, 1);
    assert.equal(restarted.sent[0]?.runId, runId);
    assert.equal(readTerminalRecord(asyncDir, runId)?.children[0]?.output, `output of ${runId}#0`);
  });
});
