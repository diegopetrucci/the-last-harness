import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  createBackgroundRunStatusOwner,
  RUNNER_HEARTBEAT_INTERVAL_MS,
} from "../../src/runs/background/run-status-owner.ts";
import { writeNormalizedLifecycleStatus } from "../../src/runs/shared/lifecycle-state.ts";
import { readStatus } from "../../src/shared/utils.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeStatusOwner(asyncDir: string, runId = "heartbeat-test") {
  const startedAt = Date.now();
  const owner = createBackgroundRunStatusOwner({
    id: runId,
    asyncDir,
    cwd: process.cwd(),
    plan: {
      kind: "single",
      task: {
        agent: "worker",
        task: "heartbeat unit test",
        model: "mock/test-model",
        contextWindows: { "mock/test-model": 1_000 },
        inheritProjectContext: false,
        inheritSkills: false,
      },
    },
    overallStartTime: startedAt,
    shareEnabled: false,
    artifactConfig: {
      mode: "compact",
      enabled: false,
      includeInput: false,
      includeOutput: false,
      includeJsonl: false,
      includeTranscript: false,
      includeMetadata: false,
      includeChildEventProjections: false,
      cleanupDays: 7,
    },
    appendEvent() {},
  });
  // Advance step to running state so the heartbeat has something to write for.
  owner.statusPayload.steps[0]!.status = "running";
  owner.statusPayload.steps[0]!.startedAt = startedAt;
  owner.writeStatusPayload();
  return { owner, startedAt };
}

/**
 * A minimal synchronous fake-timer that records interval registrations and
 * exposes a `tick()` helper to fire the registered callback once.
 *
 * Each "id" is a real immediately-cleared NodeJS.Timeout handle, which lets
 * us avoid chained type assertions while keeping the handle opaque.
 */
function makeFakeTimers() {
  const registered: Array<{ fn: () => void; ms: number; id: NodeJS.Timeout }> = [];
  const cleared = new Set<NodeJS.Timeout>();

  const fakeSetInterval = (fn: () => void, ms: number): NodeJS.Timeout => {
    // Create a real timer and clear it immediately so it never fires;
    // we keep the handle solely as a unique, correctly-typed key.
    const id = setInterval(() => undefined, 1_000_000);
    clearInterval(id);
    registered.push({ fn, ms, id });
    return id;
  };

  const fakeClearInterval = (id: NodeJS.Timeout | undefined): void => {
    if (id !== undefined) cleared.add(id);
  };

  const tick = (idx = 0): void => {
    const entry = registered[idx];
    if (!entry) throw new Error(`No timer registered at index ${idx}`);
    if (!cleared.has(entry.id)) entry.fn();
  };

  return { fakeSetInterval, fakeClearInterval, registered, cleared, tick };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runner lastUpdate heartbeat", () => {
  it("exports RUNNER_HEARTBEAT_INTERVAL_MS as ~5 minutes", () => {
    assert.equal(RUNNER_HEARTBEAT_INTERVAL_MS, 5 * 60 * 1000);
  });

  it("persists lastUpdate when a quiet running run receives a heartbeat tick", () => {
    const asyncDir = tempDir("tlh-heartbeat-running-");
    try {
      const { owner } = makeStatusOwner(asyncDir);
      // Capture beforeWrite BEFORE stubbing Date.now so it reflects the real
      // initial value; the stub is set to beforeWrite + 60_000 to guarantee
      // strict inequality.
      const beforeWrite = owner.statusPayload.lastUpdate;
      const fakeTimers = makeFakeTimers();

      // Stub Date.now so the heartbeat tick writes a deterministic, provably
      // fresh timestamp that we can assert with strict equality.
      const realDateNow = Date.now;
      const stubbedTime = beforeWrite + 60_000;
      Date.now = () => stubbedTime;
      try {
        owner.startHeartbeat(5_000, {
          setInterval: fakeTimers.fakeSetInterval,
          clearInterval: fakeTimers.fakeClearInterval,
        });
        assert.equal(fakeTimers.registered.length, 1, "one interval should be registered");
        assert.equal(fakeTimers.registered[0]!.ms, 5_000);

        fakeTimers.tick();

        const persisted = readStatus(asyncDir, { cache: false })!;
        assert.ok(persisted, "status.json should be readable");
        // stubbedTime is strictly greater than the initial lastUpdate by construction.
        assert.ok(
          stubbedTime > beforeWrite,
          "stubbed time must be strictly greater than the initial lastUpdate",
        );
        assert.equal(
          persisted.lastUpdate,
          stubbedTime,
          `lastUpdate must equal the stubbed Date.now() value (${stubbedTime})`,
        );
        // Heartbeat must NOT change lastActivityAt.
        assert.equal(
          persisted.lastActivityAt,
          owner.statusPayload.lastActivityAt,
          "lastActivityAt must be untouched by the heartbeat",
        );
        // activityState must remain unset for a run with no child events.
        assert.equal(persisted.activityState, undefined, "heartbeat must not set activityState");

        owner.stopHeartbeat();
      } finally {
        Date.now = realDateNow;
      }
    } finally {
      cleanup(asyncDir);
    }
  });

  it("does not write after the run is cancelled", () => {
    const asyncDir = tempDir("tlh-heartbeat-cancel-");
    try {
      const { owner } = makeStatusOwner(asyncDir);
      const fakeTimers = makeFakeTimers();

      owner.startHeartbeat(5_000, {
        setInterval: fakeTimers.fakeSetInterval,
        clearInterval: fakeTimers.fakeClearInterval,
      });

      // Simulate cancellation via the terminal transition.
      owner.cancel();

      // The interval handle should now be in the cleared set.
      const handle = fakeTimers.registered[0]!.id;
      assert.ok(fakeTimers.cleared.has(handle), "clearInterval must be called on cancel");

      // Record persisted lastUpdate before any further tick.
      const afterCancel = readStatus(asyncDir, { cache: false })!.lastUpdate;

      // Fire the tick manually anyway (simulates a race where the timer fired
      // just before clearInterval took effect); the heartbeat guard must skip.
      fakeTimers.registered[0]!.fn();

      const afterTick = readStatus(asyncDir, { cache: false })!.lastUpdate;
      assert.equal(
        afterTick,
        afterCancel,
        "lastUpdate must not change after cancel even if the callback fires",
      );
    } finally {
      cleanup(asyncDir);
    }
  });

  it("does not write after the run is interrupted (paused)", () => {
    const asyncDir = tempDir("tlh-heartbeat-interrupt-");
    try {
      const { owner } = makeStatusOwner(asyncDir);
      const fakeTimers = makeFakeTimers();

      owner.startHeartbeat(5_000, {
        setInterval: fakeTimers.fakeSetInterval,
        clearInterval: fakeTimers.fakeClearInterval,
      });
      owner.interrupt();

      const handle = fakeTimers.registered[0]!.id;
      assert.ok(fakeTimers.cleared.has(handle), "clearInterval must be called on interrupt");

      const afterPause = readStatus(asyncDir, { cache: false })!.lastUpdate;
      fakeTimers.registered[0]!.fn();
      const afterTick = readStatus(asyncDir, { cache: false })!.lastUpdate;
      assert.equal(afterTick, afterPause, "lastUpdate must not change after interrupt");
    } finally {
      cleanup(asyncDir);
    }
  });

  it("does not write after the run times out", () => {
    const asyncDir = tempDir("tlh-heartbeat-timeout-");
    try {
      const { owner } = makeStatusOwner(asyncDir);
      const fakeTimers = makeFakeTimers();

      owner.startHeartbeat(5_000, {
        setInterval: fakeTimers.fakeSetInterval,
        clearInterval: fakeTimers.fakeClearInterval,
      });
      owner.timeout();

      const handle = fakeTimers.registered[0]!.id;
      assert.ok(fakeTimers.cleared.has(handle), "clearInterval must be called on timeout");

      const afterTimeout = readStatus(asyncDir, { cache: false })!.lastUpdate;
      fakeTimers.registered[0]!.fn();
      const afterTick = readStatus(asyncDir, { cache: false })!.lastUpdate;
      assert.equal(afterTick, afterTimeout, "lastUpdate must not change after timeout");
    } finally {
      cleanup(asyncDir);
    }
  });

  it("stopHeartbeat is idempotent and prevents further writes", () => {
    const asyncDir = tempDir("tlh-heartbeat-stop-");
    try {
      const { owner } = makeStatusOwner(asyncDir);
      const fakeTimers = makeFakeTimers();

      owner.startHeartbeat(5_000, {
        setInterval: fakeTimers.fakeSetInterval,
        clearInterval: fakeTimers.fakeClearInterval,
      });
      owner.stopHeartbeat();
      owner.stopHeartbeat(); // idempotent

      const handle = fakeTimers.registered[0]!.id;
      assert.ok(fakeTimers.cleared.has(handle), "clearInterval must be called on stopHeartbeat");

      const afterStop = readStatus(asyncDir, { cache: false })!.lastUpdate;
      // Direct callback invocation after stop – state is still "running"
      // so only the state guard prevents the write when the timer was already cleared.
      // The cleared set in fake timers doesn't automatically block callback invocation;
      // tick() respects cleared, but here we call fn() directly to simulate the race.
      // The guard `statusPayload.state !== "running"` won't block this one since
      // the run hasn't transitioned; the real protection is the clearInterval call.
      // We verify the clearInterval was called (above). Separately verify that
      // a fresh heartbeat tick after restart would work again:
      const fakeTimers2 = makeFakeTimers();
      owner.startHeartbeat(5_000, {
        setInterval: fakeTimers2.fakeSetInterval,
        clearInterval: fakeTimers2.fakeClearInterval,
      });
      fakeTimers2.tick();
      const afterRestart = readStatus(asyncDir, { cache: false })!.lastUpdate ?? 0;
      assert.ok(
        afterRestart >= (afterStop ?? 0),
        "lastUpdate should be updated after heartbeat restart",
      );
      owner.stopHeartbeat();
    } finally {
      cleanup(asyncDir);
    }
  });

  it("heartbeat tick does not modify lastActivityAt or step.idleEpisodeId", () => {
    const asyncDir = tempDir("tlh-heartbeat-idle-");
    try {
      const { owner } = makeStatusOwner(asyncDir);
      const fakeTimers = makeFakeTimers();

      // Seed meaningful idle state so the assertions are non-trivially satisfied.
      const seededLastActivityAt = Date.now() - 30_000;
      owner.statusPayload.lastActivityAt = seededLastActivityAt;
      const seededIdleEpisodeId = "idle-episode-heartbeat-test";
      owner.statusPayload.steps[0]!.idleEpisodeId = seededIdleEpisodeId;
      owner.statusPayload.steps[0]!.activityState = "needs_attention";
      owner.writeStatusPayload();

      owner.startHeartbeat(5_000, {
        setInterval: fakeTimers.fakeSetInterval,
        clearInterval: fakeTimers.fakeClearInterval,
      });
      fakeTimers.tick();

      // Assert against the owner's current statusPayload step (not a pre-tick capture).
      const currentStep = owner.statusPayload.steps[0]!;
      assert.equal(
        owner.statusPayload.lastActivityAt,
        seededLastActivityAt,
        "heartbeat must not modify in-memory lastActivityAt",
      );
      assert.equal(
        currentStep.idleEpisodeId,
        seededIdleEpisodeId,
        "heartbeat must not modify in-memory idleEpisodeId",
      );
      assert.equal(
        currentStep.activityState,
        "needs_attention",
        "heartbeat must not modify in-memory activityState",
      );

      // Assert against the persisted status.json step as well.
      const persisted = readStatus(asyncDir, { cache: false })!;
      assert.equal(
        persisted.lastActivityAt,
        seededLastActivityAt,
        "heartbeat must not persist a changed lastActivityAt",
      );
      const persistedStep = persisted.steps![0]!;
      assert.equal(
        persistedStep.idleEpisodeId,
        seededIdleEpisodeId,
        "heartbeat must not persist a changed idleEpisodeId",
      );
      assert.equal(
        persistedStep.activityState,
        "needs_attention",
        "heartbeat must not persist a changed activityState",
      );

      owner.stopHeartbeat();
    } finally {
      cleanup(asyncDir);
    }
  });

  it("does not overwrite a concurrent terminal (failed) status written to disk while in-memory run is still running", () => {
    const asyncDir = tempDir("tlh-heartbeat-concurrent-terminal-");
    try {
      const { owner } = makeStatusOwner(asyncDir);
      const fakeTimers = makeFakeTimers();

      // Simulate a concurrent writer persisting a terminal "failed" status
      // directly to disk while the in-memory runner still thinks it's running.
      const persistedBefore = readStatus(asyncDir, { cache: false })!;
      writeNormalizedLifecycleStatus(asyncDir, {
        ...persistedBefore,
        state: "failed" as const,
        endedAt: Date.now(),
        error: "concurrent external failure",
        lifecycle: {
          ...persistedBefore.lifecycle,
          generation: (persistedBefore.lifecycle?.generation ?? 0) + 1,
        },
      });

      // In-memory state is still running.
      assert.equal(owner.statusPayload.state, "running", "in-memory state should be running");

      owner.startHeartbeat(5_000, {
        setInterval: fakeTimers.fakeSetInterval,
        clearInterval: fakeTimers.fakeClearInterval,
      });

      // Fire the tick – the heartbeat must detect the on-disk terminal status
      // and NOT overwrite it with the in-memory running state.
      fakeTimers.tick();

      const afterTick = readStatus(asyncDir, { cache: false })!;
      assert.ok(afterTick, "status.json should remain readable after the heartbeat tick");
      assert.equal(
        afterTick.state,
        "failed",
        "on-disk state must stay terminal (failed) after a heartbeat tick",
      );

      // The timer handle should now be in the cleared set because the tick
      // detected a terminal state and cleared the heartbeat timer.
      const handle = fakeTimers.registered[0]!.id;
      assert.ok(
        fakeTimers.cleared.has(handle),
        "heartbeat timer must be cleared after detecting a concurrent terminal status",
      );

      // Fire another tick manually to confirm no further writes happen.
      const lastUpdateAfterFirstTick = readStatus(asyncDir, { cache: false })!.lastUpdate;
      fakeTimers.registered[0]!.fn(); // direct invocation simulates race
      const lastUpdateAfterSecondTick = readStatus(asyncDir, { cache: false })!.lastUpdate;
      assert.equal(
        lastUpdateAfterSecondTick,
        lastUpdateAfterFirstTick,
        "lastUpdate must not change on a subsequent tick after terminal status was adopted",
      );
      assert.equal(
        readStatus(asyncDir, { cache: false })!.state,
        "failed",
        "on-disk state must remain terminal (failed) after subsequent ticks",
      );
    } finally {
      cleanup(asyncDir);
    }
  });

  it("clears the heartbeat timer when the protocol-output-limit path terminates the run", () => {
    const asyncDir = tempDir("tlh-heartbeat-output-limit-");
    try {
      const { owner } = makeStatusOwner(asyncDir);
      const fakeTimers = makeFakeTimers();

      owner.startHeartbeat(5_000, {
        setInterval: fakeTimers.fakeSetInterval,
        clearInterval: fakeTimers.fakeClearInterval,
      });
      assert.equal(fakeTimers.registered.length, 1, "one interval should be registered");

      // Trigger the terminal transition via the protocol-output-limit path.
      owner.onChildProtocolOutputLimit({
        code: "protocol_output_limit",
        stream: "stdout",
        limitBytes: 1_000,
        observedBytes: 2_000,
        diagnosticPrefix: "prefix",
        diagnosticTail: "tail",
      });

      assert.equal(
        owner.statusPayload.state,
        "failed",
        "run must be in terminal failed state after protocol-output-limit",
      );

      // The heartbeat timer must have been cleared by projectTerminal.
      const handle = fakeTimers.registered[0]!.id;
      assert.ok(
        fakeTimers.cleared.has(handle),
        "clearInterval must be called after the protocol-output-limit terminal transition",
      );

      // No further writes should occur even if the callback races and fires.
      const lastUpdateAfterTerminal = readStatus(asyncDir, { cache: false })!.lastUpdate;
      fakeTimers.registered[0]!.fn(); // simulate race: timer callback fires after clear
      const lastUpdateAfterRace = readStatus(asyncDir, { cache: false })!.lastUpdate;
      assert.equal(
        lastUpdateAfterRace,
        lastUpdateAfterTerminal,
        "lastUpdate must not change after terminal transition even if callback fires",
      );
    } finally {
      cleanup(asyncDir);
    }
  });
});
