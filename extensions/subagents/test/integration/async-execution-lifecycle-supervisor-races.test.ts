/**
 * Integration tests for async execution – supervisor pause and concurrent
 * terminal-state races.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import {
  lifecycleGeneration,
  transitionLifecycleStatus,
  withLifecycleContinuation,
  writeNormalizedLifecycleStatus,
} from "../../src/runs/shared/lifecycle-state.ts";
import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  RESULTS_DIR,
  executeAsyncParallel,
  executeAsyncSingle,
  readAsyncPayload,
  removeLifecycleLock,
  requestAsyncInterrupt,
  startedMockPiPids,
  waitForAsyncResultFile,
  waitForAsyncState,
  waitForAsyncStatusPredicate,
  waitForMockPiCall,
  waitForMockPiSignal,
  waitForPidsToExit,
  writeLifecycleLock,
} from "../support/async-execution-helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

describe("async execution utilities", () => {
  let tempDir: string;
  let mockPi: MockPi;

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });

  after(() => {
    mockPi.uninstall();
  });

  beforeEach(() => {
    tempDir = createTempDir();
    mockPi.reset();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });
  it(
    "fails closed instead of publishing paused awaiting-supervisor while a nested descendant remains active",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const id = `async-supervisor-nested-active-${Date.now().toString(36)}`;
      const nestedRoute = createNestedRoute(id);
      try {
        mockPi.onCall({
          steps: [
            {
              jsonl: [
                events.toolStart("contact_supervisor", {
                  reason: "need_decision",
                  message: "Need a decision",
                }),
              ],
            },
          ],
          ignoreSigint: true,
          keepAliveAfterFinalMessageMs: 5_000,
        });
        executeAsyncSingle!(id, {
          agent: "worker",
          task: "Ask for a supervisor decision and stop there.",
          agentConfig: makeAgent("worker"),
          ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
          artifactConfig: {
            enabled: false,
            includeInput: false,
            includeOutput: false,
            includeJsonl: false,
            includeMetadata: false,
            cleanupDays: 7,
          },
          shareEnabled: false,
          sessionRoot: path.join(tempDir, "sessions"),
          maxSubagentDepth: 2,
          nestedRoute,
        });
        const asyncDir = path.join(ASYNC_DIR, id);
        const pausingStatus = await waitForAsyncStatusPredicate(
          asyncDir,
          (status) =>
            status.state === "pausing" &&
            typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number",
          "pausing before nested descendant gate",
        );
        writeNestedEvent(nestedRoute, {
          type: "subagent.nested.started",
          ts: Date.now(),
          parentRunId: id,
          parentStepIndex: 0,
          child: {
            id: `${id}-nested-live`,
            parentRunId: id,
            parentStepIndex: 0,
            depth: 1,
            path: [{ runId: id, stepIndex: 0 }],
            asyncDir: path.join(asyncDir, "nested-live"),
            state: "running",
            agent: "nested-worker",
            startedAt: Date.now(),
            lastUpdate: Date.now(),
          },
        });
        const payload = await readAsyncPayload(id);
        const persistedStatus = JSON.parse(
          fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
        ) as AsyncStatusPayload;
        assert.equal(payload.state, "failed");
        assert.equal(payload.pause, undefined);
        assert.equal(
          payload.summary,
          "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.",
        );
        assert.equal(
          payload.error,
          "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.",
        );
        assert.equal(persistedStatus.state, "failed");
        assert.equal((persistedStatus as AsyncStatusPayload & { pid?: number }).pid, undefined);
        assert.equal(persistedStatus.pause, undefined);
        assert.equal(persistedStatus.steps?.[0]?.processCleanup?.terminated, true);
        await waitForPidsToExit(
          [pausingStatus.pid as number | undefined, ...startedMockPiPids(mockPi)],
          `failed async supervisor nested descendant ${id}`,
        );
      } finally {
        fs.rmSync(path.dirname(nestedRoute.eventSink), { recursive: true, force: true });
      }
    },
  );

  it(
    "reconciles a post-checkpoint supervisor finalization lock failure to the paused awaiting-supervisor outcome",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const id = `async-supervisor-lock-final-${Date.now().toString(36)}`;
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
        ],
        ignoreSigint: true,
        ignoreSigterm: true,
        keepAliveAfterFinalMessageMs: 30_000,
      });
      executeAsyncSingle!(id, {
        agent: "worker",
        task: "Ask for a supervisor decision and stop there.",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      const asyncDir = path.join(ASYNC_DIR, id);
      const pausingStatus = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) =>
          status.state === "pausing" &&
          typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number",
        "pausing pid before finalization lock contention",
      );
      await waitForMockPiCall(mockPi, 0);
      const childPids = startedMockPiPids(mockPi);
      assert.equal(childPids.length, 1);
      await waitForMockPiSignal(mockPi, childPids[0]!, "SIGTERM");
      await writeLifecycleLock(asyncDir);
      const lockedStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(lockedStatus.state, "pausing");
      const payload = await readAsyncPayload(id);
      assert.equal(payload.state, "paused");
      assert.equal(payload.pause?.kind, "awaiting_supervisor");
      assert.equal(fs.readdirSync(RESULTS_DIR).filter((name) => name === `${id}.json`).length, 1);
      await waitForPidsToExit(
        [pausingStatus.pid as number | undefined, ...childPids],
        `paused async supervisor finalization ${id}`,
      );
      removeLifecycleLock(asyncDir);
      const repaired = reconcileAsyncRun(asyncDir, {
        resultsDir: RESULTS_DIR,
        now: () => Date.now(),
      });
      assert.equal(typeof repaired.repaired, "boolean");
      assert.equal(repaired.status?.state, "paused");
      assert.equal(repaired.status?.pause?.kind, "awaiting_supervisor");
      const reconciledStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(reconciledStatus.state, "paused");
      assert.equal(reconciledStatus.pause?.kind, "awaiting_supervisor");
    },
  );

  // ── Regression test for tlhm-8typ: post-pause source-runner write race ───────
  //
  // When a source runner writes status after a paused checkpoint (e.g. after an
  // interrupted child settles), it must not clobber a continuation reservation
  // that a concurrent resume actor committed between the paused checkpoint and
  // the post-child write. The test exercises the REAL background runner and
  // coordinates via marker files — no wall-clock sleeps, no hardcoded counts.
  //
  // Proof of non-vacuousness: revert the `if (interrupted)` routing in
  // writeStatusPayload (using bare writeNormalizedLifecycleStatus instead of
  // mergeAndWriteSourceRunnerStatus) and this test FAILS with:
  //   "reservation must survive the post-child source-runner status write".
  // Restoring the routing makes it PASS.
  it(
    "post-pause source-runner status write preserves a concurrent continuation reservation (tlhm-8typ)",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      // Marker-file rendezvous: child signals when it is executing, then blocks
      // until the test releases it. This lets us insert the reservation after the
      // paused checkpoint but before the post-child write — deterministically.
      const markerDir = path.join(tempDir, "tlhm-8typ-markers");
      fs.mkdirSync(markerDir, { recursive: true });
      const readyMarker = path.join(markerDir, "child-ready");
      const releaseMarker = path.join(markerDir, "child-release");

      // Mock child writes the ready marker, then blocks until the release marker
      // appears. SIGINT is ignored so the child survives the interrupt and keeps
      // blocking; the test controls when it exits via the release marker.
      mockPi.onCall({
        ignoreSigint: true,
        ignoreSigterm: true,
        steps: [{ writeMarker: readyMarker }, { waitForMarker: releaseMarker }],
        output: "child work complete",
      });

      const id = `tlhm8typ-reservation-race-${Date.now().toString(36)}`;
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Do work",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-tlhm8typ" },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });

      const asyncDir = path.join(ASYNC_DIR, id);

      // ── Step 1: wait for the child to signal it is blocking (no sleep) ──────
      // Safety deadline scales with TLH_TEST_TIMEOUT_SCALE so CI (3x) gets the
      // same headroom as spawn-heavy helper defaults.
      {
        const deadline = Date.now() + scaleTestTimeout(20_000);
        while (!fs.existsSync(readyMarker)) {
          if (Date.now() > deadline) assert.fail("Timed out waiting for mock child ready marker");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      // ── Step 2: interrupt the source runner so it pauses ─────────────────────
      // requestAsyncInterrupt uses the control-channel file so it works across
      // platforms without sending OS signals to the test process.
      requestAsyncInterrupt(asyncDir, { source: "tlhm-8typ-test" });

      // ── Step 3: wait for the first paused checkpoint ─────────────────────────
      // This is the disk state the source runner holds in in-memory; any write
      // after this point that does not go through mergeAndWriteSourceRunnerStatus
      // would clobber a concurrent reservation.
      await waitForAsyncState(asyncDir, "paused");

      const pausedStatusRaw = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const pausedGen = lifecycleGeneration(
        pausedStatusRaw as Parameters<typeof lifecycleGeneration>[0],
      );

      // ── Step 4: inject a continuation reservation (simulates resume actor) ───
      const reservedClaimToken = "tlhm8typ-test-claim";
      const reservedRunId = "tlhm8typ-test-continuation";
      transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: pausedGen,
        mutate: (status) => ({
          ...status,
          lifecycle: withLifecycleContinuation(status, 0, {
            phase: "reserved" as const,
            claimToken: reservedClaimToken,
            claimedAt: Date.now(),
            ownerPid: process.pid,
            continuationRunId: reservedRunId,
          }),
        }),
      });

      // Disk now has the reservation at pausedGen + 1.
      const afterReservation = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(
        afterReservation.lifecycle?.continuation?.phase,
        "reserved",
        "sanity: reservation must be on disk before releasing the child",
      );

      // ── Step 5: release the blocking child ───────────────────────────────────
      // The child exits normally. The source runner will call writeStatusPayload()
      // after the child settles (with interrupted=true), which is the write path
      // that used to clobber the reservation before the fix.
      fs.writeFileSync(releaseMarker, "", "utf-8");

      // ── Step 6: wait for the result artifact ─────────────────────────────────
      const resultPath = await waitForAsyncResultFile(id);

      // ── Assertions ───────────────────────────────────────────────────────────
      const finalStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const resultPayload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

      // The reservation must survive every post-child source-runner status write.
      // Without the fix (bare writeNormalizedLifecycleStatus), the reservation
      // would be erased here and the test would fail.
      assert.equal(
        finalStatus.lifecycle?.continuation?.phase,
        "reserved",
        "reservation must survive the post-child source-runner status write",
      );
      assert.equal(finalStatus.lifecycle?.continuation?.claimToken, reservedClaimToken);
      assert.equal(finalStatus.lifecycle?.continuation?.continuationRunId, reservedRunId);

      // The result artifact must exist: the source runner wrote it cleanly despite
      // the interrupted+reservation scenario.
      assert.equal(
        resultPayload.state,
        "paused",
        "result artifact must reflect the paused state from the interrupted run",
      );
      assert.ok(resultPayload.results.length > 0, "result artifact must carry child results");
    },
  );

  // ── Regression test for tlhm-8typ round 5 FIX 10 + FIX 11: ordinary-interrupt
  // terminal-override path ────────────────────────────────────────────────────
  //
  // When a source runner with NO supervisorPauseRequest (ordinary interrupt) goes
  // through writeStatusPayload and the merge finds a concurrent terminal winner on
  // disk, adoptConcurrentTerminalStatus must be called in-memory immediately.
  // Before the fix the stale-generation trick only helped inside the
  // supervisorPauseRequest CAS block, which is skipped for ordinary interrupts, so
  // resultState fell through to `interrupted ? "paused" : ...` and the artifact
  // incorrectly said `state: "paused"` — contradicting the persisted terminal winner.
  //
  // Proof of non-vacuousness: revert the FIX 10 branch in writeStatusPayload to
  // the round-4 `if (!TERMINAL_RUN_STATES.has(merged.state) || merged.state ===
  // statusPayload.state)` form (which skips adoption) and this test FAILS with:
  //   "result artifact must reflect the adopted cancelled state, not stale paused".
  it(
    "ordinary-interrupt terminal override: artifact reflects the concurrent terminal winner (tlhm-8typ r5)",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const markerDir = path.join(tempDir, "tlhm-8typ-r5-markers");
      fs.mkdirSync(markerDir, { recursive: true });
      const readyMarker = path.join(markerDir, "child-ready");
      const releaseMarker = path.join(markerDir, "child-release");

      // Mock child writes the ready marker and blocks until the release marker
      // appears. SIGINT/SIGTERM are ignored so the child survives the ordinary
      // interrupt and remains blocked; the test controls exit via the release marker.
      mockPi.onCall({
        ignoreSigint: true,
        ignoreSigterm: true,
        steps: [{ writeMarker: readyMarker }, { waitForMarker: releaseMarker }],
        output: "child work complete",
      });

      const id = `tlhm8typ-r5-terminal-override-${Date.now().toString(36)}`;
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Do work",
        agentConfig: makeAgent("worker"),
        ctx: {
          pi: { events: { emit() {} } },
          cwd: tempDir,
          currentSessionId: "session-tlhm8typ-r5",
        },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });

      const asyncDir = path.join(ASYNC_DIR, id);

      // ── Step 1: wait for the child to signal it is blocking ──────────────────
      {
        const deadline = Date.now() + scaleTestTimeout(20_000);
        while (!fs.existsSync(readyMarker)) {
          if (Date.now() > deadline) assert.fail("Timed out waiting for mock child ready marker");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      // ── Step 2: ordinary interrupt (no supervisorPauseRequest) ───────────────
      requestAsyncInterrupt(asyncDir, { source: "tlhm-8typ-r5-test" });

      // ── Step 3: wait for the first paused checkpoint ─────────────────────────
      await waitForAsyncState(asyncDir, "paused");

      const pausedStatusRaw = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const pausedGen = lifecycleGeneration(
        pausedStatusRaw as Parameters<typeof lifecycleGeneration>[0],
      );

      // ── Step 4: inject a concurrent cancelled terminal state via CAS ─────────
      // Simulates an external cancel action (e.g. from a cancel tool call) that
      // commits the terminal state after the paused checkpoint but before the
      // source runner's post-child write.
      const cancelledAt = Date.now();
      transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: pausedGen,
        mutate: (status) => ({
          ...status,
          state: "cancelled" as const,
          pid: undefined,
          cancel: { summary: "Test cancellation", cancelledAt },
          endedAt: cancelledAt,
          lastUpdate: cancelledAt,
          steps: status.steps?.map((step) => ({
            ...step,
            status: "cancelled" as const,
            endedAt: cancelledAt,
            exitCode: 0,
            pause: undefined,
            cancel: { summary: "Test cancellation", cancelledAt },
          })),
        }),
      });

      // Sanity: verify the cancelled state is on disk before releasing the child.
      const afterCancel = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(
        afterCancel.state,
        "cancelled",
        "sanity: cancelled state must be on disk before releasing the child",
      );

      // ── Step 5: release the blocking child ───────────────────────────────────
      // The child exits. The source runner calls writeStatusPayload() (with
      // interrupted=true, no supervisorPauseRequest), which is the write path that
      // must now adopt the terminal winner in-memory via FIX 10.
      fs.writeFileSync(releaseMarker, "", "utf-8");

      // ── Step 6: wait for the result artifact ─────────────────────────────────
      const resultPath = await waitForAsyncResultFile(id);

      // ── Assertions ───────────────────────────────────────────────────────────
      const resultPayload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

      // FIX 10: adoption must happen in-memory at the writeStatusPayload call,
      // not deferred to a CAS block that only runs when supervisorPauseRequest
      // is set. Without the fix resultState falls through to `interrupted ? "paused"`
      // and the artifact says `state: "paused"`.
      // flag in resultState precedence (concurrentTerminalStatusAdopted wins).
      assert.equal(
        resultPayload.state,
        "cancelled",
        "result artifact must reflect the adopted cancelled state, not stale paused",
      );
    },
  );

  it(
    "terminates a live child when a locked checkpoint adopts a concurrent terminal state",
    {
      skip:
        process.platform === "win32"
          ? "cross-process lifecycle race unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const markerDir = path.join(tempDir, "async-terminal-adoption-markers");
      fs.mkdirSync(markerDir, { recursive: true });
      const readyMarker = path.join(markerDir, "child-ready");
      const releaseMarker = path.join(markerDir, "child-release");
      mockPi.onCall({
        ignoreSigint: true,
        ignoreSigterm: true,
        steps: [
          { writeMarker: readyMarker },
          { waitForMarker: releaseMarker },
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Trigger terminal adoption",
              }),
            ],
          },
        ],
        output: "terminal adoption child",
        keepAliveAfterFinalMessageMs: 60_000,
      });

      const id = `async-terminal-adoption-${Date.now().toString(36)}`;
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Wait for concurrent terminal adoption.",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });

      const asyncDir = path.join(ASYNC_DIR, id);
      const readyDeadline = Date.now() + scaleTestTimeout(20_000);
      while (!fs.existsSync(readyMarker)) {
        if (Date.now() > readyDeadline)
          assert.fail("Timed out waiting for mock child ready marker");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await waitForMockPiCall(mockPi, 0);
      const childPids = startedMockPiPids(mockPi);
      assert.equal(childPids.length, 1);

      const runningStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const generation = lifecycleGeneration(
        runningStatus as Parameters<typeof lifecycleGeneration>[0],
      );
      const cancelledAt = Date.now();
      transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: generation,
        mutate: (status) => ({
          ...status,
          state: "cancelled" as const,
          pid: undefined,
          cancel: { summary: "Concurrent terminal adoption", cancelledAt },
          endedAt: cancelledAt,
          lastUpdate: cancelledAt,
          steps: status.steps?.map((step) => ({
            ...step,
            status: "cancelled" as const,
            endedAt: cancelledAt,
            exitCode: 0,
            cancel: { summary: "Concurrent terminal adoption", cancelledAt },
          })),
        }),
      });
      fs.writeFileSync(releaseMarker, "", "utf-8");

      const resultPath = await waitForAsyncResultFile(id);
      await waitForPidsToExit(childPids, `terminal-adopted child ${id}`);
      const resultPayload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      assert.equal(resultPayload.state, "cancelled");
    },
  );

  // ── Finding 1 parallel-batch pin: concurrent terminal adoption must prevent a
  // queued parallel task from starting ─────────────────────────────────────────
  //
  // This test pins the PARALLEL CALLBACK GUARD in subagent-runner.ts — the early
  // return inside mapConcurrent's callback that checks
  // `interrupted || concurrentTerminalStatusAdopted`. With concurrency:1, task 2
  // is queued while task 1 runs. After task 1 releases, the callback for task 2
  // must observe concurrentTerminalStatusAdopted=true and return early without
  // launching a child process.
  //
  // The single-run Finding 1 test above does NOT reach this guard because it
  // stops before entering the parallel batch. This test exercises the callback guard
  // independently.
  //
  // Proof of non-vacuousness (pins the parallel callback guard):
  //   Revert ONLY the parallel callback guard —
  //   `if (interrupted || concurrentTerminalStatusAdopted) return pausedStepResult(task);`
  //   inside mapConcurrent — leaving the outer loop guard intact.
  //   With that guard removed this test FAILS with:
  //     "parallel task 2 must not start after concurrent terminal adoption"
  //     expected: 1   actual: 2   operator: strictEqual
  //   (verified against current code; see PR #503 review, Finding 1).
  it(
    "concurrent terminal adoption: queued parallel task does not start after non-paused terminal is adopted (parallel callback guard)",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const markerDir = path.join(tempDir, "finding1-parallel-markers");
      fs.mkdirSync(markerDir, { recursive: true });
      const task1ReadyMarker = path.join(markerDir, "task1-ready");
      const task1ReleaseMarker = path.join(markerDir, "task1-release");

      // Task 1: write the ready marker, then block until the release marker appears.
      // Ignores SIGINT/SIGTERM so it stays alive until we control it.
      mockPi.onCall({
        ignoreSigint: true,
        ignoreSigterm: true,
        steps: [{ writeMarker: task1ReadyMarker }, { waitForMarker: task1ReleaseMarker }],
        output: "task 1 done",
      });

      // Task 2 is deliberately not queued on mockPi — if it starts, the mock will
      // have an unexpected call and the callCount assertion will catch it.

      // Single parallel group with concurrency:1 so task 2 is queued while task 1 runs.
      const id = `finding1-parallel-no-task2-${Date.now().toString(36)}`;
      executeAsyncParallel(id, {
        tasks: [
          { agent: "worker", task: "Parallel task one" },
          { agent: "worker", task: "Parallel task two" },
        ],
        concurrency: 1,
        agents: [makeAgent("worker")],
        ctx: {
          pi: { events: { emit() {} } },
          cwd: tempDir,
          currentSessionId: "session-finding1-parallel",
        },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });

      const asyncDir2 = path.join(ASYNC_DIR, id);

      // ── Step 1: wait for task 1 to signal it is blocking ─────────────────────
      {
        const deadline = Date.now() + scaleTestTimeout(20_000);
        while (!fs.existsSync(task1ReadyMarker)) {
          if (Date.now() > deadline)
            assert.fail("Timed out waiting for task 1 ready marker (finding-1-parallel)");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      // ── Step 2: ordinary interrupt so the source runner pauses ─────────────────
      requestAsyncInterrupt(asyncDir2, { source: "finding1-parallel-test" });
      await waitForAsyncState(asyncDir2, "paused");

      const pausedStatusRaw2 = JSON.parse(
        fs.readFileSync(path.join(asyncDir2, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const pausedGen2 = lifecycleGeneration(
        pausedStatusRaw2 as Parameters<typeof lifecycleGeneration>[0],
      );

      // ── Step 3: inject concurrent CANCELLED state on top of the paused checkpoint
      // With concurrency:1, task 2 is queued in mapConcurrent but has not started.
      // When we release task 1 below, mapConcurrent will pick up task 2 next.
      // The parallel callback guard must observe concurrentTerminalStatusAdopted=true
      // and return early before launching a child process for task 2.
      const cancelledAt2 = Date.now();
      transitionLifecycleStatus({
        asyncDir: asyncDir2,
        expectedGeneration: pausedGen2,
        mutate: (status) => ({
          ...status,
          state: "cancelled" as const,
          pid: undefined,
          cancel: { summary: "Test cancellation (finding-1-parallel)", cancelledAt: cancelledAt2 },
          endedAt: cancelledAt2,
          lastUpdate: cancelledAt2,
          steps: status.steps?.map((step) => ({
            ...step,
            status: "cancelled" as const,
            endedAt: cancelledAt2,
            exitCode: 0,
            pause: undefined,
            cancel: {
              summary: "Test cancellation (finding-1-parallel)",
              cancelledAt: cancelledAt2,
            },
          })),
        }),
      });

      const afterCancel2 = JSON.parse(
        fs.readFileSync(path.join(asyncDir2, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(
        afterCancel2.state,
        "cancelled",
        "sanity: cancelled state must be on disk before releasing task 1 (parallel)",
      );

      // ── Step 4: release task 1 ────────────────────────────────────────────────
      // Task 1 exits. mapConcurrent processes task 2's callback next (concurrency:1).
      // Pre-fix (parallel guard removed): task 2 would launch a child process.
      // Post-fix: the callback guard checks concurrentTerminalStatusAdopted=true and
      // returns pausedStepResult without starting a child.
      fs.writeFileSync(task1ReleaseMarker, "", "utf-8");

      // ── Step 5: wait for the result artifact ────────────────────────────────
      const resultPath2 = await waitForAsyncResultFile(id, scaleTestTimeout(30_000));

      // ── Assertions ────────────────────────────────────────────────────────────
      const resultPayload2 = JSON.parse(
        fs.readFileSync(resultPath2, "utf-8"),
      ) as AsyncResultPayload;

      // Task 2 must never have started: callCount() counts actual mock-pi invocations.
      assert.equal(
        mockPi.callCount(),
        1,
        "parallel task 2 must not start after concurrent terminal adoption",
      );
      // The result must reflect the concurrent terminal winner.
      assert.equal(
        resultPayload2.state,
        "cancelled",
        "result artifact must reflect the adopted cancelled state (finding-1-parallel)",
      );
    },
  );

  // ── INVARIANT PIN (not a bug reproduction) ────────────────────────────────
  //
  // Invariant: pause + a concurrent cancel committed through the lock/CAS path ⇒
  // the persisted status still reports `cancelled` with its cancel metadata intact,
  // and no step is left reporting `paused`, no matter how many post-adoption
  // child-settle writeStatusPayload calls occur.
  //
  // HONESTY NOTE — read before treating this as a regression repro:
  // This test PASSES both before and after the writeStatusPayload merge-routing
  // change. It is deliberately NOT claimed to be non-vacuous. An earlier review
  // hypothesis held that a post-adoption bare write could clobber the persisted
  // `cancelled` record here; that hypothesis was investigated and found to be
  // WRONG for the current code, because three independent mechanisms already
  // prevent the clobber:
  //   1. the finalization block is gated on `!concurrentTerminalStatusAdopted`, so
  //      its state mutation and status write are both skipped after adoption;
  //   2. both step handlers re-set `interrupted = true` via
  //      `if (childInterrupted) interrupted = true;` before their settle write,
  //      which pushed the write back onto the locked-merge path; and
  //   3. `pausedCheckpointCommitted` happened to still be true.
  // The merge-routing change exists to make the invariant hold BY CONSTRUCTION
  // instead of by that coincidence, and to keep late settlement fields merged
  // rather than dropped. This test pins the observable invariant so a future
  // refactor of any of those three mechanisms cannot silently regress it.
  it(
    "invariant pin: pause + concurrent cancel keeps the persisted cancelled record intact",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const markerDir = path.join(tempDir, "invariant-pin-markers");
      fs.mkdirSync(markerDir, { recursive: true });
      const child0ReadyMarker = path.join(markerDir, "child0-ready");
      const child1ReadyMarker = path.join(markerDir, "child1-ready");
      // Both children share a single release marker so they exit at roughly the same
      // time — ensuring both child-settle writeStatusPayload calls fire and at least
      // one fires AFTER the first adoption.
      const releaseMarker = path.join(markerDir, "release");

      // Each child ignores SIGINT/SIGTERM so it survives the ordinary interrupt and
      // stays blocked until the release marker appears.
      mockPi.onCall({
        ignoreSigint: true,
        ignoreSigterm: true,
        steps: [{ writeMarker: child0ReadyMarker }, { waitForMarker: releaseMarker }],
        output: "child 0 done",
      });
      mockPi.onCall({
        ignoreSigint: true,
        ignoreSigterm: true,
        steps: [{ writeMarker: child1ReadyMarker }, { waitForMarker: releaseMarker }],
        output: "child 1 done",
      });

      const id = `invariant-pin-pause-cancel-${Date.now().toString(36)}`;
      executeAsyncParallel(id, {
        tasks: [
          { agent: "worker", task: "Task A" },
          { agent: "worker", task: "Task B" },
        ],
        concurrency: 2,
        agents: [makeAgent("worker")],
        ctx: {
          pi: { events: { emit() {} } },
          cwd: tempDir,
          currentSessionId: "session-invariant-pin",
        },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });

      const asyncDir = path.join(ASYNC_DIR, id);

      // ── Step 1: wait for both children to signal they are blocking ────────────
      {
        const deadline = Date.now() + scaleTestTimeout(20_000);
        while (!fs.existsSync(child0ReadyMarker) || !fs.existsSync(child1ReadyMarker)) {
          if (Date.now() > deadline)
            assert.fail("Timed out waiting for both child ready markers (invariant pin)");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      // ── Step 2: ordinary interrupt → paused checkpoint ────────────────────────
      requestAsyncInterrupt(asyncDir, { source: "invariant-pin-test" });
      await waitForAsyncState(asyncDir, "paused");

      const pausedStatusRaw = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const pausedGen = lifecycleGeneration(
        pausedStatusRaw as Parameters<typeof lifecycleGeneration>[0],
      );

      // ── Step 3: commit `cancelled` on top of the paused checkpoint via CAS ────
      // Simulates a cancel actor committing a terminal state AFTER the paused
      // checkpoint but BEFORE the source runner's post-child writes.
      const cancelledAt = Date.now();
      transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: pausedGen,
        mutate: (status) => ({
          ...status,
          state: "cancelled" as const,
          pid: undefined,
          cancel: { summary: "invariant pin test cancellation", cancelledAt },
          endedAt: cancelledAt,
          lastUpdate: cancelledAt,
          steps: status.steps?.map((step) => ({
            ...step,
            status: "cancelled" as const,
            endedAt: cancelledAt,
            exitCode: 0,
            pause: undefined,
            cancel: { summary: "invariant pin test cancellation", cancelledAt },
          })),
        }),
      });

      // Sanity: cancelled is on disk before releasing the children.
      const afterCancel = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(
        afterCancel.state,
        "cancelled",
        "sanity: cancelled must be on disk before releasing children",
      );

      // ── Step 4: release both children simultaneously ──────────────────────────
      // When both children exit, their task handlers each call writeStatusPayload().
      // The first call takes the locked-merge path, detects the cancelled terminal
      // winner, and calls adoptConcurrentTerminalStatus — setting interrupted=false
      // and concurrentTerminalStatusAdopted=true while pausedCheckpointCommitted
      // stays true. The second child's settle write then also runs post-adoption.
      // With merge routing keyed on concurrentTerminalStatusAdopted, that second
      // write is merged against disk (persisted terminal wins) instead of being able
      // to fall through to a bare write.
      fs.writeFileSync(releaseMarker, "", "utf-8");

      // ── Step 5: wait for the result artifact ─────────────────────────────────
      const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(30_000));

      // ── Assertions ───────────────────────────────────────────────────────────
      const status = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;

      // Run-level: must retain the cancel record from the CAS commit.
      assert.equal(
        status.state,
        "cancelled",
        "run state must remain cancelled after post-adoption child-settle writes",
      );
      assert.equal(
        status.cancel?.summary,
        "invariant pin test cancellation",
        "run-level cancel metadata must be intact after post-adoption child-settle writes",
      );

      // Step-level: the second child's settle write must NOT have mutated any step
      // status back to "paused". Both steps must retain their cancelled status.
      const stepStatuses = status.steps?.map((s) => s.status) ?? [];
      for (let i = 0; i < stepStatuses.length; i++) {
        assert.equal(
          stepStatuses[i],
          "cancelled",
          `step statuses must all be cancelled after pause-then-cancel — step ${i} still ${stepStatuses[i]}`,
        );
      }

      // Result artifact must reflect the concurrent terminal winner.
      const resultPayload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      assert.equal(
        resultPayload.state,
        "cancelled",
        "result artifact must reflect the adopted cancelled state (invariant pin)",
      );
    },
  );

  // ── Regression test for tlhm-c7so: continuation launch gate writes result artifact
  //
  // When runSubagent rejects a continuation at the launch gate, it previously took
  // an early return that skipped the terminal result writer at the bottom of the
  // function. Any waiter blocking on RESULTS_DIR/${id}.json would hang until its
  // own timeout (~20% of CI runs failed this way for four days).
  //
  // Fix: write a terminal failure result artifact to resultPath before the early
  // return (option b — explicit inline payload with documented consumer contract).
  //
  // Proof of non-vacuousness: remove the writeAtomicJson call from the gate-rejection
  // block in subagent-runner.ts and this test FAILS with:
  //   "Timed out waiting for async result file: .../<id>.json"
  // Restoring the write makes it PASS.
  it("continuation launch gate writes a terminal failure result artifact (tlhm-c7so)", async () => {
    // Set up a source asyncDir. Writing a paused lifecycle status + reservation
    // makes the gate scenario realistic: the continuation runner starts with a
    // stale or mismatched claimToken and the gate returns { finalized: false }.
    const sourceRunId = `gate-reject-source-${Date.now().toString(36)}`;
    const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
    fs.mkdirSync(sourceAsyncDir, { recursive: true });

    // Write a paused lifecycle status for the source run.
    writeNormalizedLifecycleStatus(sourceAsyncDir, {
      runId: sourceRunId,
      mode: "single",
      state: "paused",
      startedAt: Date.now() - 5000,
      steps: [{ agent: "worker", status: "paused" }],
    });

    // Add a continuation reservation with a specific claimToken.
    const sourceGen = lifecycleGeneration(
      JSON.parse(fs.readFileSync(path.join(sourceAsyncDir, "status.json"), "utf-8")),
    );
    transitionLifecycleStatus({
      asyncDir: sourceAsyncDir,
      expectedGeneration: sourceGen,
      mutate: (status) => ({
        ...status,
        lifecycle: withLifecycleContinuation(status, 0, {
          phase: "reserved" as const,
          claimToken: "original-claim-token",
          claimedAt: Date.now(),
          ownerPid: process.pid,
          continuationRunId: "will-be-overridden",
        }),
      }),
    });

    // Launch the continuation with a DIFFERENT claimToken so the gate rejects.
    // The subprocess exits immediately — no mock pi invocations occur.
    const continuationId = `gate-reject-cont-${Date.now().toString(36)}`;
    executeAsyncSingle(continuationId, {
      agent: "worker",
      task: "Resume work",
      agentConfig: makeAgent("worker"),
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-gate-reject",
      },
      continuationSource: {
        asyncDir: sourceAsyncDir,
        runId: sourceRunId,
        index: 0,
        claimToken: "rival-claim-token", // mismatched → gate rejects
      },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });

    // The result file must appear. Without the fix (no writeAtomicJson before the
    // early return), this times out — proving the test is non-vacuous.
    const resultPath = await waitForAsyncResultFile(continuationId, scaleTestTimeout(15_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

    assert.equal(result.success, false, "gate-rejected continuation must report success: false");
    assert.equal(result.state, "failed", "gate-rejected continuation must report state: failed");
    assert.equal(
      result.sessionId,
      "session-gate-reject",
      "gate-rejected continuation result must carry sessionId for delivery",
    );
    assert.equal(
      (result as AsyncResultPayload & { id?: string }).id,
      continuationId,
      "gate-rejected continuation result must carry the continuation run id",
    );
    assert.ok(
      Array.isArray(result.results) && result.results.length === 1,
      "gate-rejected continuation must have one child result",
    );
    assert.equal(result.results[0]?.success, false, "child result must report success: false");
    assert.ok(
      typeof result.error === "string" && result.error.includes(sourceRunId),
      "error must reference the source run id",
    );
  });
});
