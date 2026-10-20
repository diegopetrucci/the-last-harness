/**
 * Real-run #770 lifecycle regressions: consumed active runtime survives
 * pause/interrupt/success continuations on awaited and detached runs, and the
 * paused wall gap is never charged against the instance's role budget.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { deliverInterruptRequest } from "../../src/runs/background/control-channel.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import {
  makeNativeResultLifecycleExecutor,
  readAsyncStatusJson,
  waitForAsyncState,
  waitForFile,
  waitForAsyncStatusPredicate,
  waitForRevivedAsyncResult,
  type ExecutorResult,
} from "../support/native-result-lifecycle-fixtures.ts";

const BUDGET_MS = 600_000;
const WORK_MS = 600;
const PAUSED_WALL_GAP_MS = 1_500;

type StatusJson = {
  state?: string;
  pid?: number;
  startedAt?: number;
  steps?: Array<{ status?: string; activeRuntimeMs?: number }>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("active-runtime lifecycle regressions (real runs)", () => {
  let tempDir: string;
  let mockPi: MockPi;
  const cleanup: string[] = [];

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });
  after(() => mockPi.uninstall());
  beforeEach(() => {
    tempDir = createTempDir("pi-active-runtime-lifecycle-");
    mockPi.reset();
  });
  afterEach(() => {
    for (const entry of cleanup.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
    removeTempDir(tempDir);
  });

  function makeExecutor() {
    return makeNativeResultLifecycleExecutor(tempDir, {
      agents: [makeAgent("worker", { maxExecutionTimeMs: BUDGET_MS })],
    }).executor;
  }

  function track(runId: string): void {
    cleanup.push(path.join(ASYNC_DIR, runId), path.join(RESULTS_DIR, `${runId}.json`));
  }

  function pauseCall(): void {
    mockPi.onCall({
      steps: [
        {
          delay: WORK_MS,
          jsonl: [
            events.toolStart("contact_supervisor", {
              reason: "need_decision",
              message: "Need a decision",
            }),
          ],
        },
      ],
      keepAliveAfterFinalMessageMs: 5_000,
    });
  }

  /** Locate the run directory a fresh launch created for this temp cwd. */
  async function discoverRunId(): Promise<string> {
    const real = (value: string) => fs.realpathSync.native(value);
    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (Date.now() < deadline) {
      for (const name of fs.existsSync(ASYNC_DIR) ? fs.readdirSync(ASYNC_DIR) : []) {
        try {
          const status = readAsyncStatusJson<StatusJson & { cwd?: string }>(name);
          if (status.cwd && real(status.cwd) === real(tempDir)) return name;
        } catch {
          // Directory still being written or belongs to another suite.
        }
      }
      await sleep(20);
    }
    throw new Error("run directory was never created");
  }

  /** Launch a real worker run, awaited (default) or detached (async: true). */
  async function launch(awaited: boolean): Promise<{ runId: string; settled: Promise<unknown> }> {
    const settled = makeExecutor().execute(
      `launch-${Date.now()}`,
      { agent: "worker", task: "Do the work.", ...(awaited ? {} : { async: true }) },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    const runId = await discoverRunId();
    track(runId);
    return { runId, settled };
  }

  async function consumed(runId: string, state: string): Promise<number> {
    await waitForAsyncState(runId, state, scaleTestTimeout(20_000));
    const status = readAsyncStatusJson<StatusJson>(runId);
    const ms = status.steps?.[0]?.activeRuntimeMs;
    assert.equal(typeof ms, "number", "consumed active runtime must be persisted");
    return ms!;
  }

  /**
   * Resume after a paused wall gap and assert the new instance is charged only
   * its persisted consumption: remaining allowance = role budget - consumed.
   */
  async function resumeCharging(runId: string, priorMs: number) {
    await sleep(PAUSED_WALL_GAP_MS);
    const resumedAt = Date.now();
    const resumed: ExecutorResult = await makeExecutor().execute(
      `resume-${Date.now()}`,
      { action: "resume", id: runId, message: "Continue." },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(resumed.isError, undefined, resumed.content[0]?.text ?? "");
    const revivedId = resumed.details?.asyncId;
    assert.ok(revivedId, "expected continuation run id");
    track(revivedId);
    await waitForFile(path.join(ASYNC_DIR, revivedId, "status.json"));
    assert.equal(
      (resumed.details as { timeoutMs?: number } | undefined)?.timeoutMs,
      BUDGET_MS - priorMs,
      "remaining allowance is the role budget minus persisted consumption",
    );
    return { revivedId, resumedAt };
  }

  function assertNotChargedForGap(finalMs: number, priorMs: number, resumedAt: number): void {
    assert.ok(finalMs >= priorMs, `consumption never shrinks (${finalMs} < ${priorMs})`);
    assert.ok(
      finalMs <= priorMs + (Date.now() - resumedAt) + 50,
      `paused wall gap must not be charged (${finalMs} vs prior ${priorMs})`,
    );
  }

  for (const awaited of [true, false]) {
    const mode = awaited ? "awaited" : "detached";
    describe(`${mode} runs`, () => {
      it("supervisor pause then resume preserves consumed runtime and skips the paused gap", async () => {
        pauseCall();
        const { runId } = await launch(awaited);
        const priorMs = await consumed(runId, "paused");
        assert.ok(priorMs >= WORK_MS / 2, `pre-pause work is charged (${priorMs}ms)`);
        mockPi.onCall({ output: "resumed after supervisor reply" });
        const { revivedId, resumedAt } = await resumeCharging(runId, priorMs);
        await waitForRevivedAsyncResult({ details: { asyncId: revivedId }, content: [] });
        assertNotChargedForGap(await consumed(revivedId, "complete"), priorMs, resumedAt);
      });

      it("interrupt then resume preserves consumed runtime and skips the paused gap", async () => {
        const readyMarker = path.join(tempDir, `child-ready-${awaited ? "a" : "d"}.marker`);
        mockPi.onCall({ delay: 30_000, output: "never finishes", writeMarker: readyMarker });
        const { runId } = await launch(awaited);
        // The mock child writes the marker only once it is actually running;
        // run state and runner PID alone can precede child start on slow CI.
        await waitForFile(readyMarker, scaleTestTimeout(20_000));
        const running = await waitForAsyncStatusPredicate(
          runId,
          (status) => status.state === "running" && typeof (status as StatusJson).pid === "number",
          "running with pid",
          scaleTestTimeout(10_000),
        ).then(() => readAsyncStatusJson<StatusJson>(runId));
        await sleep(WORK_MS);
        deliverInterruptRequest({
          asyncDir: path.join(ASYNC_DIR, runId),
          pid: running.pid,
          source: "test",
        });
        const priorMs = await consumed(runId, "paused");
        assert.ok(priorMs >= WORK_MS / 2, `pre-interrupt work is charged (${priorMs}ms)`);
        mockPi.onCall({ output: "resumed after interrupt" });
        const { revivedId, resumedAt } = await resumeCharging(runId, priorMs);
        await waitForRevivedAsyncResult({ details: { asyncId: revivedId }, content: [] });
        assertNotChargedForGap(await consumed(revivedId, "complete"), priorMs, resumedAt);
      });

      it("successful completion then same-lineage revival keeps the consumed runtime", async () => {
        mockPi.onCall({ delay: WORK_MS, output: "first pass done" });
        const { runId } = await launch(awaited);
        const priorMs = await consumed(runId, "complete");
        assert.ok(priorMs >= WORK_MS / 2, `completed work is charged (${priorMs}ms)`);
        mockPi.onCall({ output: "second pass done" });
        const { revivedId, resumedAt } = await resumeCharging(runId, priorMs);
        await waitForRevivedAsyncResult({ details: { asyncId: revivedId }, content: [] });
        assertNotChargedForGap(await consumed(revivedId, "complete"), priorMs, resumedAt);
      });

      it("budget accumulates across consecutive continuations instead of resetting", async () => {
        pauseCall();
        const { runId } = await launch(awaited);
        const firstMs = await consumed(runId, "paused");
        pauseCall();
        const second = await resumeCharging(runId, firstMs);
        const secondMs = await consumed(second.revivedId, "paused");
        assert.ok(
          secondMs >= firstMs + WORK_MS / 2,
          `second segment adds to the first (${firstMs} -> ${secondMs})`,
        );
        assertNotChargedForGap(secondMs, firstMs + WORK_MS, second.resumedAt);
        mockPi.onCall({ output: "third segment done" });
        const third = await resumeCharging(second.revivedId, secondMs);
        await waitForRevivedAsyncResult({ details: { asyncId: third.revivedId }, content: [] });
        assert.ok((await consumed(third.revivedId, "complete")) >= secondMs);
      });
    });
  }
});
