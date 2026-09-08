import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  TERMINAL_RUN_STATES,
  lifecycleGeneration,
  mergeAndWriteSourceRunnerStatus,
  transitionLifecycleStatus,
  withLifecycleContinuation,
  withLifecycleStatusLock,
  writeNormalizedLifecycleStatus,
} from "../../src/runs/shared/lifecycle-state.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { tempRoot } from "../support/lifecycle-state-fixtures.ts";

describe("lifecycle state helpers", () => {
  it("merges higher persisted runtime evidence without lowering local lifecycle state", () => {
    const root = tempRoot("pi-lifecycle-runtime-merge-");
    try {
      const asyncDir = path.join(root, "run-runtime-merge");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-runtime-merge",
        mode: "single",
        state: "running",
        startedAt: 100,
        lastUpdate: 1_900,
        activeRuntimeMs: 900,
        activeRuntimeCheckpointAt: 1_900,
        steps: [
          {
            agent: "worker",
            status: "running",
            activeRuntimeMs: 900,
            activeRuntimeCheckpointAt: 1_900,
          },
        ],
      });

      const merged = mergeAndWriteSourceRunnerStatus(asyncDir, {
        runId: "run-runtime-merge",
        mode: "single",
        state: "running",
        startedAt: 100,
        lastUpdate: 1_400,
        activeRuntimeMs: 400,
        activeRuntimeCheckpointAt: 1_400,
        steps: [
          {
            agent: "worker",
            status: "running",
            activeRuntimeMs: 400,
            activeRuntimeCheckpointAt: 1_400,
          },
        ],
      });

      assert.equal(merged.activeRuntimeMs, 900);
      assert.equal(merged.activeRuntimeCheckpointAt, 1_900);
      assert.equal(merged.steps?.[0]?.activeRuntimeMs, 900);
      assert.equal(merged.steps?.[0]?.activeRuntimeCheckpointAt, 1_900);
      assert.equal(readStatus(asyncDir)?.activeRuntimeMs, 900);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Regression tests for the post-pause source-runner status write race ─────
  //
  // Root cause (tlhm-8typ): after the source runner writes a "pausing"
  // checkpoint via transitionLifecycleStatus (generation N+1), a resuming actor
  // can race in and reserve a continuation (generation N+2). Any subsequent bare
  // writeNormalizedLifecycleStatus call from the still-running source runner
  // (settling interrupted children, writing the final paused status) would
  // overwrite disk with the stale in-memory payload (generation N+1, no
  // continuation) — erasing the reservation and making the resumed run fail its
  // launch gate without writing a result artifact.
  //
  // Fix: mergeAndWriteSourceRunnerStatus acquires the lifecycle lock, reads the
  // persisted status, and merges before writing, preserving any continuation.
  //
  // Handshake: all operations in these tests are synchronous. The "race" is
  // reproduced deterministically by interleaving transitionLifecycleStatus
  // (reservation) between two mergeAndWriteSourceRunnerStatus calls. Against the
  // old code (bare writeNormalizedLifecycleStatus), the continuation assertion
  // after step 4 would fail because the reservation would be gone.

  it("post-pause source-runner writes preserve a concurrent continuation reservation", () => {
    const root = tempRoot("pi-lifecycle-post-pause-race-");
    try {
      const asyncDir = path.join(root, "run-post-pause-race");

      // Step 1: Source runner writes initial running status (gen 0).
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-post-pause-race",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });

      // Step 2: Source runner transitions to "pausing" (gen 0→1).
      // After this, the source runner holds inMemory.lifecycle.generation = 1.
      const pausingTransition = transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: 0,
        mutate: (status) => ({
          ...status,
          state: "pausing",
          pid: 1234,
          pause: { kind: "awaiting_supervisor", ownerPid: 1234, requestedAt: 110 },
          steps: [{ ...status.steps?.[0], agent: "worker", status: "pausing" }],
        }),
      });
      assert.equal(pausingTransition.nextGeneration, 1);

      // Step 3: Resume actor reserves a continuation (gen 1→2).
      // This races with the source runner's subsequent writeStatusPayload calls.
      const reservationTransition = transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: 1,
        mutate: (status) => ({
          ...status,
          lifecycle: withLifecycleContinuation(status, 0, {
            phase: "reserved",
            claimToken: "claim-race-test",
            claimedAt: 120,
            ownerPid: 5678,
            continuationRunId: "resumed-race-run",
          }),
        }),
      });
      assert.equal(reservationTransition.nextGeneration, 2);
      assert.equal(readStatus(asyncDir)?.lifecycle?.generation, 2);
      assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.phase, "reserved");

      // Step 4: Source runner settles an interrupted child and writes status.
      // The in-memory payload is stale: generation=1, no continuation.
      // A bare writeNormalizedLifecycleStatus would clobber the reservation.
      // mergeAndWriteSourceRunnerStatus must preserve it.
      const staleInMemory = {
        ...pausingTransition.status,
        state: "paused" as const,
        steps: [{ agent: "worker", status: "paused" as const, exitCode: 0, endedAt: 200 }],
      };
      // Verify: old bare write would erase the reservation.
      // (Demonstrated by comment; we do NOT call writeNormalizedLifecycleStatus
      // here because that is the bug we are testing against.)
      const written = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);

      const persisted = readStatus(asyncDir);
      // Reservation must survive the post-pause source-runner write.
      assert.equal(persisted?.lifecycle?.continuation?.phase, "reserved");
      assert.equal(persisted?.lifecycle?.continuation?.claimToken, "claim-race-test");
      assert.equal(persisted?.lifecycle?.continuation?.continuationRunId, "resumed-race-run");
      // Generation must not regress below the reservation generation.
      assert.ok((persisted?.lifecycle?.generation ?? 0) >= 2, "generation must not regress");
      // Step data from the source runner must still be written.
      assert.equal(persisted?.steps?.[0]?.status, "paused");
      assert.equal(persisted?.steps?.[0]?.exitCode, 0);
      // Return value reflects the merged on-disk content.
      assert.equal(written.lifecycle?.continuation?.phase, "reserved");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("post-pause source-runner writes cannot downgrade a continued run state to paused", () => {
    const root = tempRoot("pi-lifecycle-continued-downgrade-");
    try {
      const asyncDir = path.join(root, "run-continued-downgrade");

      // Persisted status is already "continued" (resumed run launched and finalized).
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-continued-downgrade",
        mode: "single",
        state: "continued",
        startedAt: 100,
        endedAt: 210,
        steps: [{ agent: "worker", status: "continued", exitCode: 0, endedAt: 210 }],
        lifecycle: {
          generation: 3,
          continuation: {
            phase: "continued",
            claimToken: "claim-done",
            claimedAt: 150,
            continuedAt: 205,
            continuationRunId: "revived-done",
          },
        },
      });

      // Source runner holds stale in-memory payload at generation 1.
      const staleInMemory = {
        runId: "run-continued-downgrade",
        mode: "single" as const,
        state: "paused" as const,
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" as const, exitCode: 0, endedAt: 200 }],
        lifecycle: { generation: 1 },
      };
      const written = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);

      const persisted = readStatus(asyncDir);
      // State must not be downgraded to "paused".
      assert.equal(persisted?.state, "continued");
      // Step must not be reverted.
      assert.equal(persisted?.steps?.[0]?.status, "continued");
      // Continuation metadata must be intact.
      assert.equal(persisted?.lifecycle?.continuation?.phase, "continued");
      assert.equal(persisted?.lifecycle?.continuation?.continuationRunId, "revived-done");
      // Generation must not regress.
      assert.ok((persisted?.lifecycle?.generation ?? 0) >= 3, "generation must not regress");
      // Return value reflects the merged on-disk content.
      assert.equal(written.state, "continued");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("post-pause source-runner writes preserve a cancelled run state committed by a concurrent CAS writer", () => {
    const root = tempRoot("pi-lifecycle-cancelled-preserve-");
    try {
      const asyncDir = path.join(root, "run-cancelled-preserve");

      // Persisted status: run was cancelled at generation 2 via lock/CAS
      // (e.g. by the cancel action while the source runner was still exiting).
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-cancelled-preserve",
        mode: "single" as const,
        state: "cancelled" as const,
        startedAt: 100,
        endedAt: 210,
        cancel: { cancelledAt: 205, summary: "User cancelled" },
        steps: [
          {
            agent: "worker",
            status: "cancelled" as const,
            exitCode: 1,
            endedAt: 210,
            cancel: { cancelledAt: 205, summary: "User cancelled" },
          },
        ],
        lifecycle: { generation: 2 },
      });

      // Source runner holds a stale in-memory payload at generation 1, still
      // writing "paused" — this is the resurrection bug: without the fix,
      // the merge would overwrite the cancelled state with paused.
      const staleInMemory = {
        runId: "run-cancelled-preserve",
        mode: "single" as const,
        state: "paused" as const,
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" as const, exitCode: 0, endedAt: 200 }],
        lifecycle: { generation: 1 },
      };
      const written = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);

      const persisted = readStatus(asyncDir);
      // The cancelled state must survive; the source runner must not resurrect it.
      assert.equal(
        persisted?.state,
        "cancelled",
        "cancelled run must not be resurrected to paused",
      );
      assert.equal(
        persisted?.steps?.[0]?.status,
        "cancelled",
        "cancelled step must not be reverted to paused",
      );
      // Cancel metadata from the persisted CAS write must be intact.
      assert.equal(persisted?.cancel?.summary, "User cancelled");
      assert.equal(persisted?.steps?.[0]?.cancel?.summary, "User cancelled");
      // Generation must not regress.
      assert.ok((persisted?.lifecycle?.generation ?? 0) >= 2, "generation must not regress");
      // Return value reflects the merged on-disk content.
      assert.equal(written.state, "cancelled");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── tlhm-8typ FIX 8: terminal-vs-terminal merge and CAS downgrade prevention ─

  it("persisted terminal run state wins over a conflicting in-memory terminal state (terminal-vs-terminal)", () => {
    const root = tempRoot("pi-lifecycle-terminal-vs-terminal-");
    try {
      const asyncDir = path.join(root, "run-terminal-vs-terminal");

      // Persisted: run was cancelled at generation 2 via lock/CAS.
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-terminal-vs-terminal",
        mode: "single" as const,
        state: "cancelled" as const,
        startedAt: 100,
        endedAt: 210,
        cancel: { cancelledAt: 205, summary: "Operator cancelled" },
        steps: [
          {
            agent: "worker",
            status: "cancelled" as const,
            exitCode: 1,
            endedAt: 210,
            cancel: { cancelledAt: 205, summary: "Operator cancelled" },
          },
        ],
        lifecycle: { generation: 2 },
      });

      // Source runner holds a stale in-memory payload at generation 1 with a
      // DIFFERENT terminal state ("failed"). Without the fix, the merge would let
      // the in-memory terminal state overwrite the persisted terminal winner
      // because the old condition was `&& !TERMINAL_RUN_STATES.has(inMemory.state)`.
      const staleInMemory = {
        runId: "run-terminal-vs-terminal",
        mode: "single" as const,
        state: "failed" as const,
        error: "source runner error",
        startedAt: 100,
        steps: [{ agent: "worker", status: "failed" as const, exitCode: 1, endedAt: 200 }],
        lifecycle: { generation: 1 },
      };
      const written = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);

      const persisted = readStatus(asyncDir);
      // Persisted terminal (cancelled) must beat in-memory terminal (failed).
      assert.equal(
        persisted?.state,
        "cancelled",
        "persisted terminal state must win over conflicting in-memory terminal",
      );
      // Cancel metadata from the CAS writer must be intact.
      assert.equal(persisted?.cancel?.summary, "Operator cancelled");
      assert.equal(persisted?.endedAt, 210, "persisted endedAt must be preserved");
      // Step must carry the persisted terminal status and cancel metadata.
      assert.equal(persisted?.steps?.[0]?.status, "cancelled");
      assert.equal(persisted?.steps?.[0]?.cancel?.summary, "Operator cancelled");
      // A cancelled winner has no error — the stale in-memory error must NOT survive.
      assert.equal(
        persisted?.error,
        undefined,
        "cancelled winner must not retain stale in-memory error",
      );
      assert.equal(written.error, undefined, "returned merged record must not carry stale error");
      // Generation must not regress.
      assert.ok((persisted?.lifecycle?.generation ?? 0) >= 2, "generation must not regress");
      // Return value reflects the merged on-disk content.
      assert.equal(written.state, "cancelled");
      // TERMINAL_RUN_STATES export sanity check (guards the export itself).
      assert.ok(TERMINAL_RUN_STATES.has("cancelled"));
      assert.ok(TERMINAL_RUN_STATES.has("continued"));
      assert.ok(!TERMINAL_RUN_STATES.has("paused"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persisted failed step error survives onto the merged record (not cleared by in-memory step)", () => {
    // FIX 1 assertion (a): a persisted failed step's error must be preserved
    // in the merged result, not overwritten by a stale in-memory step without error.
    const root = tempRoot("pi-lifecycle-step-error-survives-");
    try {
      const asyncDir = path.join(root, "run-step-error-survives");

      // Persisted: step failed with an error committed by the CAS writer.
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-step-error-survives",
        mode: "single" as const,
        state: "failed" as const,
        startedAt: 100,
        endedAt: 200,
        error: "winner step failure",
        steps: [
          {
            agent: "worker",
            status: "failed" as const,
            exitCode: 1,
            endedAt: 200,
            error: "winner step failure",
          },
        ],
        lifecycle: { generation: 2 },
      });

      // In-memory: stale paused step with no error.
      const staleInMemory = {
        runId: "run-step-error-survives",
        mode: "single" as const,
        state: "paused" as const,
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" as const }],
        lifecycle: { generation: 1 },
      };
      const written = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);

      const persisted = readStatus(asyncDir);
      // Run-level error from persisted winner must survive.
      assert.equal(
        persisted?.error,
        "winner step failure",
        "persisted failed run error must survive onto merged record",
      );
      assert.equal(
        written.error,
        "winner step failure",
        "returned merged record must carry persisted run error",
      );
      // Step-level error from persisted winner must survive.
      assert.equal(
        persisted?.steps?.[0]?.error,
        "winner step failure",
        "persisted failed step error must survive onto merged record",
      );
      assert.equal(
        written.steps?.[0]?.error,
        "winner step failure",
        "returned merged step must carry persisted step error",
      );
      assert.equal(persisted?.state, "failed");
      assert.equal(persisted?.steps?.[0]?.status, "failed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancelled winner clears stale in-memory error at both run and step level (FIX 1 assertion b)", () => {
    // FIX 1 assertion (b): a cancelled winner (no error) must clear a stale
    // in-memory error/failed payload at both run and step level.
    // Concrete case from PR #503 review.
    const root = tempRoot("pi-lifecycle-cancel-clears-error-");
    try {
      const asyncDir = path.join(root, "run-cancel-clears-error");

      // Persisted: run was cancelled — no error field.
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-cancel-clears-error",
        mode: "single" as const,
        state: "cancelled" as const,
        startedAt: 100,
        endedAt: 210,
        cancel: { cancelledAt: 205, summary: "Operator cancel" },
        steps: [
          {
            agent: "worker",
            status: "cancelled" as const,
            exitCode: 0,
            endedAt: 210,
            cancel: { cancelledAt: 205, summary: "Operator cancel" },
          },
        ],
        lifecycle: { generation: 2 },
      });

      // In-memory: stale failed step with an error.
      const staleInMemory = {
        runId: "run-cancel-clears-error",
        mode: "single" as const,
        state: "paused" as const,
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" as const, error: "stale step error" }],
        lifecycle: { generation: 1 },
      };
      const written = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);

      const persisted = readStatus(asyncDir);
      // Cancelled winner has no error — stale in-memory error must be cleared.
      assert.equal(
        persisted?.error,
        undefined,
        "cancelled winner must clear stale run-level error",
      );
      assert.equal(
        written.error,
        undefined,
        "returned merged record must not carry stale run error",
      );
      // Step-level: cancelled step has no error — stale step error must be cleared.
      assert.equal(
        persisted?.steps?.[0]?.error,
        undefined,
        "cancelled winner must clear stale step error",
      );
      assert.equal(
        written.steps?.[0]?.error,
        undefined,
        "returned merged step must not carry stale step error",
      );
      assert.equal(persisted?.state, "cancelled");
      assert.equal(persisted?.steps?.[0]?.status, "cancelled");
      // Cancel metadata from persisted winner must be intact.
      assert.equal(persisted?.cancel?.summary, "Operator cancel");
      assert.equal(persisted?.steps?.[0]?.cancel?.summary, "Operator cancel");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stale-generation CAS invariant: transitionLifecycleStatus with an old generation is rejected", () => {
    // This test verifies the generic CAS invariant: a transitionLifecycleStatus call
    // that presents a generation number that is behind the persisted generation is
    // rejected with an "expected generation" error. This prevents any stale writer
    // from downgrading a persisted terminal state.
    //
    // Note: this test verifies the CAS mechanism directly by calling
    // transitionLifecycleStatus with a manually retained old generation. It does
    // not exercise writeStatusPayload or the runner finalization path.
    const root = tempRoot("pi-lifecycle-cas-downgrade-");
    try {
      const asyncDir = path.join(root, "run-cas-downgrade");

      // Persisted: run cancelled at generation 2 (written via lock/CAS).
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-cas-downgrade",
        mode: "single" as const,
        state: "cancelled" as const,
        startedAt: 100,
        endedAt: 210,
        cancel: { cancelledAt: 205, summary: "User cancelled" },
        steps: [{ agent: "worker", status: "cancelled" as const, exitCode: 1, endedAt: 210 }],
        lifecycle: { generation: 2 },
      });

      // Source runner in-memory payload at generation 1, still "pausing".
      const staleInMemory = {
        runId: "run-cas-downgrade",
        mode: "single" as const,
        state: "pausing" as const,
        startedAt: 100,
        steps: [{ agent: "worker", status: "pausing" as const }],
        lifecycle: { generation: 1 },
      };

      // mergeAndWriteSourceRunnerStatus writes "cancelled" to disk and returns
      // the merged status (which includes generation 2).
      const merged = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);
      assert.equal(merged.state, "cancelled");
      assert.equal(lifecycleGeneration(merged), 2);

      // Hold onto the old generation (1) to simulate a stale caller.
      const originalGen = lifecycleGeneration(staleInMemory); // = 1

      // Attempt a CAS using the old generation (1). This would be a downgrade
      // attempt (e.g. writing "paused" over "cancelled").
      // It MUST fail because the persisted status is at generation 2.
      assert.throws(
        () =>
          transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: originalGen, // 1 — old, pre-terminal
            mutate: (status) => ({ ...status, state: "paused" }), // would downgrade
          }),
        /expected generation/,
        "CAS with old generation must be rejected",
      );

      // Persisted state must still be "cancelled" after the failed CAS attempt.
      assert.equal(
        readStatus(asyncDir)?.state,
        "cancelled",
        "persisted terminal winner must survive the CAS attempt",
      );
      assert.equal(
        readStatus(asyncDir)?.lifecycle?.generation,
        2,
        "generation must not advance from a failed CAS",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("mergeAndWriteSourceRunnerStatus skips the write and returns persisted status when lock is exhausted", () => {
    const root = tempRoot("pi-lifecycle-lock-exhausted-");
    try {
      const asyncDir = path.join(root, "run-lock-exhausted");

      // Write initial status with a reservation.
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-lock-exhausted",
        mode: "single" as const,
        state: "paused" as const,
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" as const }],
        lifecycle: {
          generation: 2,
          continuation: {
            phase: "reserved" as const,
            claimToken: "claim-lock-exhausted",
            claimedAt: 150,
            ownerPid: 5678,
            continuationRunId: "resumed-lock-exhausted",
          },
        },
      });

      // Hold the lifecycle lock so lock acquisition is exhausted immediately.
      const staleInMemory = {
        runId: "run-lock-exhausted",
        mode: "single" as const,
        state: "paused" as const,
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" as const, exitCode: 0, endedAt: 200 }],
        lifecycle: { generation: 1 }, // stale generation
      };

      let returned: ReturnType<typeof mergeAndWriteSourceRunnerStatus> | undefined;
      withLifecycleStatusLock(asyncDir, () => {
        // Lock is held here. mergeAndWriteSourceRunnerStatus must not write
        // and must return the persisted status (not the stale in-memory).
        returned = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);
      });

      // The write was skipped: persisted status should be unchanged.
      const persisted = readStatus(asyncDir);
      assert.equal(
        persisted?.lifecycle?.generation,
        2,
        "generation must not change when write is skipped",
      );
      assert.equal(
        persisted?.lifecycle?.continuation?.phase,
        "reserved",
        "reservation must be preserved",
      );
      // Return value is the persisted status (not the stale in-memory).
      assert.equal(
        returned?.lifecycle?.generation,
        2,
        "returned status must reflect persisted generation",
      );
      assert.equal(returned?.lifecycle?.continuation?.claimToken, "claim-lock-exhausted");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Finding 2: stale run-level pid/pause survive terminal merge ─────────────
  //
  // When the persisted run state is terminal and the in-memory state is non-terminal,
  // the merged record must NOT keep the source runner's stale `pid` or `pause` fields.
  // A consumer reading `pid` or `pause` on a terminal record would incorrectly
  // believe the run is still alive and supervised.
  //
  // Proof of non-vacuousness: remove `pid: undefined, pause: undefined` from
  // terminalRunOverrides in lifecycle-state.ts and this test FAILS with:
  //   "terminal merged record must not carry stale pid"
  //   "terminal merged record must not carry stale pause"
  it("mergeAndWriteSourceRunnerStatus clears stale pid and pause on terminal run override (finding-2)", () => {
    const root = tempRoot("pi-lifecycle-finding2-");
    try {
      const asyncDir = path.join(root, "run-finding2");

      // Persisted: run cancelled at generation 2 — committed by a CAS writer.
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-finding2",
        mode: "single" as const,
        state: "cancelled" as const,
        startedAt: 100,
        endedAt: 210,
        cancel: { cancelledAt: 205, summary: "Operator cancelled" },
        steps: [{ agent: "worker", status: "cancelled" as const }],
        lifecycle: { generation: 2 },
      });

      // In-memory: still "pausing" with stale source-runner ownership fields.
      const staleInMemory = {
        runId: "run-finding2",
        mode: "single" as const,
        state: "pausing" as const,
        startedAt: 100,
        // These are the stale ownership fields that must be cleared.
        pid: 12345,
        pause: {
          kind: "awaiting_supervisor" as const,
          summary: "Waiting for supervisor",
          ownerPid: 12345,
        },
        steps: [{ agent: "worker", status: "pausing" as const }],
        lifecycle: { generation: 1 },
      };

      const merged = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);

      // The terminal run override must clear pid and pause.
      assert.equal(merged.pid, undefined, "terminal merged record must not carry stale pid");
      assert.equal(merged.pause, undefined, "terminal merged record must not carry stale pause");
      // The terminal state and its cancel metadata must survive.
      assert.equal(merged.state, "cancelled");
      assert.equal(merged.cancel?.summary, "Operator cancelled");
      // The persisted record on disk must also have pid/pause cleared.
      const persisted = readStatus(asyncDir);
      assert.equal(persisted?.pid, undefined, "persisted record must not carry stale pid");
      assert.equal(persisted?.pause, undefined, "persisted record must not carry stale pause");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Finding 3: adopted "failed" terminal loses its error reason ─────────────
  //
  // When persisted is "failed" and in-memory is non-terminal, terminalRunOverrides
  // must carry `error` from the persisted record. Without this fix the merged record
  // has `state: "failed"` but the in-memory `error` (usually undefined), losing
  // the failure reason committed by the CAS writer.
  //
  // Proof of non-vacuousness: remove the `persisted.error` spread from
  // terminalRunOverrides in lifecycle-state.ts and this test FAILS with:
  //   "terminal merged record must carry the persisted failure reason"
  it("mergeAndWriteSourceRunnerStatus carries persisted error on failed terminal override (finding-3)", () => {
    const root = tempRoot("pi-lifecycle-finding3-");
    try {
      const asyncDir = path.join(root, "run-finding3");

      // Persisted: run failed with a specific error reason at generation 2.
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-finding3",
        mode: "single" as const,
        state: "failed" as const,
        startedAt: 100,
        endedAt: 200,
        error: "CAS writer: step timed out after 30s",
        steps: [{ agent: "worker", status: "failed" as const, error: "Timed out" }],
        lifecycle: { generation: 2 },
      });

      // In-memory: still "pausing", no error set.
      const staleInMemory = {
        runId: "run-finding3",
        mode: "single" as const,
        state: "pausing" as const,
        startedAt: 100,
        steps: [{ agent: "worker", status: "pausing" as const }],
        lifecycle: { generation: 1 },
      };

      const merged = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);

      // The terminal run override must carry the persisted error.
      assert.equal(
        merged.error,
        "CAS writer: step timed out after 30s",
        "terminal merged record must carry the persisted failure reason",
      );
      assert.equal(merged.state, "failed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Finding 4: same-terminal step early return drops metadata ─────────────
  //
  // When persisted and in-memory steps agree on a terminal status, the persisted
  // writer may have committed lifecycle metadata (cancel, endedAt) that the
  // in-memory step does not have. The early return `return step` must be replaced
  // with a merge that carries persisted metadata while keeping source-owned fields.
  //
  // Proof of non-vacuousness: revert the `if (persistedStep.status === step.status)`
  // block to `return step` in lifecycle-state.ts and this test FAILS with:
  //   "same-terminal step merge must carry persisted endedAt"
  //   "same-terminal step merge must carry persisted cancel metadata"
  it("mergeAndWriteSourceRunnerStatus preserves persisted step metadata when both sides agree on terminal status (finding-4)", () => {
    const root = tempRoot("pi-lifecycle-finding4-");
    try {
      const asyncDir = path.join(root, "run-finding4");
      const persistedEndedAt = 250;
      const persistedCancelledAt = 240;

      // Persisted: step "cancelled" WITH cancel metadata and endedAt.
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-finding4",
        mode: "single" as const,
        state: "cancelled" as const,
        startedAt: 100,
        endedAt: persistedEndedAt,
        cancel: { cancelledAt: persistedCancelledAt, summary: "User cancelled" },
        steps: [
          {
            agent: "worker",
            status: "cancelled" as const,
            // The concurrent writer committed cancel metadata and endedAt.
            endedAt: persistedEndedAt,
            exitCode: 0,
            cancel: { cancelledAt: persistedCancelledAt, summary: "User cancelled" },
          },
        ],
        lifecycle: { generation: 2 },
      });

      // In-memory: step already "cancelled" (source runner knows the same status)
      // but WITHOUT the cancel metadata or endedAt — the in-memory step was
      // settled before the concurrent writer committed metadata.
      const staleInMemory = {
        runId: "run-finding4",
        mode: "single" as const,
        state: "paused" as const,
        startedAt: 100,
        steps: [
          {
            agent: "worker",
            // Same terminal status as persisted — triggers the early-return path.
            status: "cancelled" as const,
            // Source-owned settlement field that must be preserved.
            model: "claude-3-5-sonnet-20241022",
            // No endedAt, no cancel metadata.
          },
        ],
        lifecycle: { generation: 1 },
      };

      const merged = mergeAndWriteSourceRunnerStatus(asyncDir, staleInMemory);

      const mergedStep = merged.steps?.[0];
      assert.ok(mergedStep, "merged step must exist");
      // Persisted metadata must be present.
      assert.equal(
        mergedStep.endedAt,
        persistedEndedAt,
        "same-terminal step merge must carry persisted endedAt",
      );
      assert.deepEqual(
        mergedStep.cancel,
        { cancelledAt: persistedCancelledAt, summary: "User cancelled" },
        "same-terminal step merge must carry persisted cancel metadata",
      );
      // Source-owned settlement field must be preserved.
      assert.equal(
        mergedStep.model,
        "claude-3-5-sonnet-20241022",
        "source-owned model field must survive merge",
      );
      // A terminal step has no active pause.
      assert.equal(mergedStep.pause, undefined, "terminal step must not carry an active pause");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
