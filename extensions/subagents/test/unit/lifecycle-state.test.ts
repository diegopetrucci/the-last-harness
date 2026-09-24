import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  advanceLifecycleContinuation,
  boundSupervisorSummary,
  lifecycleGeneration,
  recoverStaleLifecycleContinuationClaim,
  transitionLifecycleStatus,
  withLifecycleContinuation,
  withLifecycleStatusLock,
  writeNormalizedLifecycleStatus,
} from "../../src/runs/shared/lifecycle-state.ts";
import { claimAttentionNotification } from "../../src/runs/background/run-control-owner.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { readStatus } from "../../src/shared/utils.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";
import { expectNoSecretInError, tempRoot } from "../support/lifecycle-state-fixtures.ts";

describe("lifecycle state helpers", () => {
  it("bounds and sanitizes supervisor summaries", () => {
    const bounded = boundSupervisorSummary("  waiting\u0000\nfor\t supervisor  ", 18);
    assert.equal(bounded, "waiting for sup…");
    assert.ok((bounded?.length ?? 0) > 0);
  });

  it("claims one attention episode and bounds the durable claim ring", () => {
    const root = tempRoot("pi-attention-claims-");
    try {
      const asyncDir = path.join(root, "run-attention");
      const claimed = Array.from({ length: 40 }, (_, index) =>
        claimAttentionNotification(asyncDir, { generation: 3, index: 1, episode: `idle-${index}` }),
      );
      assert.equal(claimed.every(Boolean), true);
      const claimDir = path.join(asyncDir, "control", "attention-claims");
      const files = fs.readdirSync(claimDir);
      assert.ok(files.length <= 32);
      assert.equal(
        claimAttentionNotification(asyncDir, { generation: 3, index: 1, episode: "idle-39" }),
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("hashes legacy path-unsafe idle episode claims without suppressing notices", () => {
    const root = tempRoot("pi-attention-legacy-episode-");
    try {
      const asyncDir = path.join(root, "run-attention");
      assert.equal(
        claimAttentionNotification(asyncDir, {
          generation: 4,
          index: 2,
          episode: "legacy/episode with a path",
        }),
        true,
      );
      const claimDir = path.join(asyncDir, "control", "attention-claims");
      const [claimName] = fs.readdirSync(claimDir);
      assert.ok(claimName);
      assert.match(claimName, /^4-2-legacy-[0-9a-f]{64}\.claim$/);
      assert.doesNotMatch(claimName, /legacy\/episode/);
      assert.equal(
        claimAttentionNotification(asyncDir, {
          generation: 4,
          index: 2,
          episode: "legacy/episode with a path",
        }),
        false,
      );
      assert.equal(
        claimAttentionNotification(asyncDir, {
          generation: 4,
          index: 2,
          episode: "\u0000malformed",
        }),
        false,
      );
      assert.equal(
        claimAttentionNotification(asyncDir, {
          generation: 4,
          index: 2,
          episode: "x".repeat(129),
        }),
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes persisted lifecycle metadata while preserving parse compatibility and privacy", () => {
    const root = tempRoot("pi-lifecycle-read-");
    try {
      const asyncDir = path.join(root, "run-legacy");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-legacy",
            mode: "single",
            state: "paused",
            startedAt: 100,
            activeRuntimeMs: 999999,
            activeRuntimeCheckpointAt: 123456,
            activityState: "active_long_running",
            durableAttentionReasons: ["context_pressure"],
            steps: [
              {
                agent: "worker",
                status: "paused",
                activeRuntimeMs: 888888,
                activeRuntimeCheckpointAt: 654321,
                activityState: "active_long_running",
                durableAttentionReasons: ["context_pressure"],
              },
            ],
            pause: {
              kind: "awaiting_supervisor",
              summary: "  need\nhelp  ",
              ownerPid: -1,
              request: {
                tool: "contact_supervisor",
                reason: "need_decision",
                requestId: " req-1 ",
                summary: "  private summary  ",
                interview: { secret: true },
                args: { token: "SECRET" },
              },
            },
            lifecycle: {
              continuation: {
                claimToken: "bad token with spaces and /private/root/secret",
                continuationRunId: `${"x".repeat(200)}`,
              },
            },
            processCleanup: {
              supported: true,
              attempted: true,
              terminated: false,
              processGroupId: 4321,
              liveProcessesDetected: true,
              escalatedToSigkill: false,
              signals: ["SIGINT", "SIGTERM"],
              warnings: ["cleanup still pending"],
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const status = readStatus(asyncDir);
      assert.equal(status?.state, "paused");
      assert.equal(status?.activityState, undefined);
      assert.equal(status?.steps?.[0]?.activityState, undefined);
      assert.equal(Object.hasOwn(status, "durableAttentionReasons"), false);
      assert.equal(Object.hasOwn(status?.steps?.[0] ?? {}, "durableAttentionReasons"), false);
      assert.equal(Object.hasOwn(status, "activeRuntimeMs"), false);
      assert.equal(Object.hasOwn(status, "activeRuntimeCheckpointAt"), false);
      const normalizedStep = status.steps?.[0];
      assert.equal(
        normalizedStep ? Object.hasOwn(normalizedStep, "activeRuntimeMs") : false,
        false,
      );
      assert.equal(
        normalizedStep ? Object.hasOwn(normalizedStep, "activeRuntimeCheckpointAt") : false,
        false,
      );
      assert.equal(status?.pause?.kind, "awaiting_supervisor");
      assert.equal(status?.pause?.summary, "need help");
      assert.equal(status?.pause?.ownerPid, undefined);
      assert.deepEqual(status?.pause?.request, {
        tool: "contact_supervisor",
        reason: "need_decision",
        requestId: "req-1",
        summary: "private summary",
      });
      assert.deepEqual(status?.processCleanup, {
        supported: true,
        attempted: true,
        terminated: false,
        processGroupId: 4321,
        liveProcessesDetected: true,
        escalatedToSigkill: false,
        signals: ["SIGINT", "SIGTERM"],
        warnings: ["cleanup still pending"],
      });
      assert.equal(lifecycleGeneration(status), 0);
      assert.equal(status?.lifecycle?.continuation?.claimToken, undefined);
      assert.equal(status?.lifecycle?.continuation?.continuationRunId, undefined);

      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-legacy",
            mode: "single",
            state: "pausing",
            startedAt: 100,
            steps: [{ agent: "worker", status: "pausing" }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const pausingStatus = readStatus(asyncDir);
      assert.equal(pausingStatus?.state, "pausing");
      assert.equal(pausingStatus?.steps?.[0]?.status, "pausing");

      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId: "run-legacy",
          mode: "single",
          state: "continued",
          startedAt: 100,
          steps: [{ agent: "worker", status: "completed" }],
        }),
        "utf8",
      );
      const canonical = readStatus(asyncDir);
      assert.equal(canonical?.state, "complete");
      assert.equal(canonical?.steps?.[0]?.status, "complete");
      assert.deepEqual(canonical?.lifecycle?.continuation, { phase: "completed" });
      const rawDisk = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as {
        lifecycle?: unknown;
      };
      assert.equal(rawDisk.lifecycle, undefined, "legacy read projection must not rewrite disk");
      assert.match(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"), /continued/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tracks only valid active compaction records across persisted reads", () => {
    const root = tempRoot("pi-lifecycle-compaction-");
    try {
      const status = writeNormalizedLifecycleStatus(root, {
        runId: "run-compaction",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [
          { agent: "worker", status: "running", compaction: { reason: "threshold" } },
          { agent: "other", status: "running", compaction: { reason: "invalid" as never } },
        ],
      });
      assert.deepEqual(status.steps?.[0]?.compaction, { reason: "threshold" });
      assert.equal(status.steps?.[1]?.compaction, undefined);
      const reread = readStatus(root);
      assert.deepEqual(reread?.steps?.[0]?.compaction, { reason: "threshold" });
      assert.equal(reread?.steps?.[1]?.compaction, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops oversized request identifiers while preserving safe continuation tokens", () => {
    const root = tempRoot("pi-lifecycle-bounds-");
    try {
      const normalized = writeNormalizedLifecycleStatus(root, {
        runId: "run-bounds",
        mode: "single",
        state: "paused",
        startedAt: 100,
        pause: {
          kind: "awaiting_supervisor",
          request: {
            tool: "contact_supervisor",
            reason: "need_decision",
            requestId: `req-${"x".repeat(200)}`,
          },
        },
        lifecycle: {
          continuation: {
            claimToken: "claim-safe-123",
            continuationRunId: "continued-safe-123",
          },
        },
        steps: [{ agent: "worker", status: "paused" }],
      });
      assert.equal(normalized.pause?.request?.requestId, undefined);
      assert.equal(normalized.lifecycle?.continuation?.claimToken, "claim-safe-123");
      assert.equal(normalized.lifecycle?.continuation?.continuationRunId, "continued-safe-123");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes transitions atomically with monotonic guarded generations", () => {
    const root = tempRoot("pi-lifecycle-transition-");
    try {
      const asyncDir = path.join(root, "run-guarded");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-guarded",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });

      const pausing = transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: 0,
        mutate: (status) => ({
          ...status,
          state: "pausing",
          pid: 123,
          pause: {
            kind: "awaiting_supervisor",
            summary: "Need decision",
            ownerPid: 123,
            requestedAt: 150,
          },
          steps: [{ ...status.steps?.[0], agent: "worker", status: "pausing" }],
        }),
      });
      assert.equal(pausing.previousGeneration, 0);
      assert.equal(pausing.nextGeneration, 1);
      const paused = transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: 1,
        mutate: (status) => ({
          ...status,
          state: "paused",
          pid: undefined,
          pause: { ...status.pause!, ownerPid: undefined, pausedAt: 200 },
          steps: [
            { ...status.steps?.[0], agent: "worker", status: "paused", endedAt: 200, exitCode: 0 },
          ],
        }),
      });
      assert.equal(paused.previousGeneration, 1);
      assert.equal(paused.nextGeneration, 2);
      const continued = transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: 2,
        mutate: (status) => ({
          ...status,
          state: "continued",
          steps: [
            {
              ...status.steps?.[0],
              agent: "worker",
              status: "continued",
              endedAt: 250,
              exitCode: 0,
            },
          ],
        }),
      });
      assert.equal(continued.previousGeneration, 2);
      assert.equal(continued.nextGeneration, 3);
      assert.equal(readStatus(asyncDir)?.lifecycle?.generation, 3);
      assert.throws(
        () =>
          transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: 0,
            mutate: (status) => status,
          }),
        /expected generation 0, found 3/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects re-entrant lifecycle transitions before a second mutation can enter", () => {
    const secret = "SECRET-LOCK-ROOT-12345";
    const root = path.join(tempRoot("pi-lifecycle-lock-"), secret, "private-runspace");
    try {
      const asyncDir = path.join(root, "run-locked");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-locked",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });

      let outerMutations = 0;
      let innerMutations = 0;
      const transitioned = transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: 0,
        mutate: (status) => {
          outerMutations += 1;
          expectNoSecretInError(
            () =>
              transitionLifecycleStatus({
                asyncDir,
                expectedGeneration: 0,
                mutate: (nestedStatus) => {
                  innerMutations += 1;
                  return nestedStatus;
                },
              }),
            secret,
            /status lock/,
          );
          assert.equal(innerMutations, 0);
          return {
            ...status,
            state: "pausing",
            steps: [
              {
                ...status.steps?.[0],
                agent: status.steps?.[0]?.agent ?? "worker",
                status: "pausing",
              },
            ],
          };
        },
      });
      assert.equal(outerMutations, 1);
      assert.equal(transitioned.status.state, "pausing");
      assert.equal(readStatus(asyncDir)?.lifecycle?.generation, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the shared lifecycle lock for read-only canonical checks", () => {
    const secret = "SECRET-LOCK-READ-24680";
    const root = path.join(tempRoot("pi-lifecycle-read-lock-"), secret, "private-runspace");
    try {
      const asyncDir = path.join(root, "run-read-locked");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-read-locked",
        mode: "single",
        state: "paused",
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" }],
      });
      assert.equal(
        withLifecycleStatusLock(asyncDir, (status) => status?.state),
        "paused",
      );
      expectNoSecretInError(
        () =>
          withLifecycleStatusLock(
            asyncDir,
            () => withLifecycleStatusLock(asyncDir, () => undefined, { retryDelaysMs: [] }),
            { retryDelaysMs: [] },
          ),
        secret,
        /status lock/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports stale generations after the lock holder commits", () => {
    const secret = "SECRET-STALE-ROOT-67890";
    const root = path.join(tempRoot("pi-lifecycle-stale-"), secret, "private-runspace");
    try {
      const asyncDir = path.join(root, "run-stale");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-stale",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: 0,
        mutate: (status) => ({
          ...status,
          state: "paused",
          pause: { kind: "cohort_pause", pausedAt: 200 },
        }),
      });
      expectNoSecretInError(
        () =>
          transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: 0,
            mutate: (status) => status,
          }),
        secret,
        /expected generation 0, found 1/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reclaims leaked transition locks only after confirming the recorded owner pid is dead", () => {
    const root = tempRoot("pi-lifecycle-lock-reclaim-");
    try {
      const asyncDir = path.join(root, "run-dead-owner");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-dead-owner",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const lockDir = path.join(asyncDir, ".lifecycle-transition.lock");
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ token: "owner-dead", pid: 4242, acquiredAt: 150 }),
        "utf-8",
      );

      const transitioned = transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: 0,
        lockOptions: {
          kill: () => {
            const error = new Error("dead") as NodeJS.ErrnoException;
            error.code = "ESRCH";
            throw error;
          },
          retryDelaysMs: [],
        },
        mutate: (status) => ({
          ...status,
          state: "paused",
          pause: { kind: "cohort_pause", pausedAt: 200 },
        }),
      });
      assert.equal(transitioned.status.state, "paused");
      assert.equal(readStatus(asyncDir)?.lifecycle?.generation, 1);
      assert.equal(fs.existsSync(lockDir), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never reclaims a transition lock while the recorded owner pid is alive or unknown", () => {
    const root = tempRoot("pi-lifecycle-lock-live-");
    try {
      const asyncDir = path.join(root, "run-live-owner");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-live-owner",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const lockDir = path.join(asyncDir, ".lifecycle-transition.lock");
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ token: "owner-live", pid: 5555, acquiredAt: 150 }),
        "utf-8",
      );
      assert.throws(
        () =>
          transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: 0,
            lockOptions: { kill: () => true, retryDelaysMs: [] },
            mutate: (status) => status,
          }),
        /status lock \(pid 5555, acquired 1970-01-01T00:00:00.150Z\)/,
      );
      assert.equal(fs.existsSync(lockDir), true);
      assert.throws(
        () =>
          transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: 0,
            lockOptions: {
              kill: () => {
                const error = new Error("no access") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
              },
              retryDelaysMs: [],
            },
            mutate: (status) => status,
          }),
        /status lock \(pid 5555, acquired 1970-01-01T00:00:00.150Z\)/,
      );
      assert.equal(fs.existsSync(lockDir), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps missing or malformed transition owners live and unreclaimable", () => {
    const root = tempRoot("pi-lifecycle-lock-ownerless-");
    try {
      const asyncDir = path.join(root, "run-ownerless");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-ownerless",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const lockDir = path.join(asyncDir, ".lifecycle-transition.lock");
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, "owner.json"), "{not-json", "utf-8");
      fs.utimesSync(lockDir, new Date(0), new Date(0));
      for (const now of [5_000, 20_000]) {
        assert.throws(
          () =>
            transitionLifecycleStatus({
              asyncDir,
              expectedGeneration: 0,
              lockOptions: { now: () => now, retryDelaysMs: [] },
              mutate: (status) => ({ ...status, state: "paused" }),
            }),
          /status lock/,
        );
        assert.equal(fs.existsSync(lockDir), true);
      }
      assert.equal(readStatus(asyncDir)?.state, "running");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never deletes a replacement transition lock owner during stale-lock recovery", () => {
    const root = tempRoot("pi-lifecycle-lock-race-");
    try {
      const asyncDir = path.join(root, "run-replacement-owner");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-replacement-owner",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const lockDir = path.join(asyncDir, ".lifecycle-transition.lock");
      const ownerPath = path.join(lockDir, "owner.json");
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(
        ownerPath,
        JSON.stringify({ token: "owner-old", pid: 7001, acquiredAt: 150 }),
        "utf-8",
      );
      let checks = 0;
      assert.throws(
        () =>
          transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: 0,
            lockOptions: {
              kill: () => {
                checks += 1;
                if (checks === 1) {
                  fs.writeFileSync(
                    ownerPath,
                    JSON.stringify({ token: "owner-new", pid: 7002, acquiredAt: 160 }),
                    "utf-8",
                  );
                }
                const error = new Error("dead") as NodeJS.ErrnoException;
                error.code = "ESRCH";
                throw error;
              },
              retryDelaysMs: [],
            },
            mutate: (status) => status,
          }),
        /status lock \(pid 7002, acquired 1970-01-01T00:00:00.160Z\)/,
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(ownerPath, "utf-8")) as {
          token: string;
          pid: number;
          acquiredAt: number;
        },
        { token: "owner-new", pid: 7002, acquiredAt: 160 },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing persisted status without leaking local roots", () => {
    const secret = "SECRET-MISSING-ROOT-24680";
    const root = path.join(tempRoot("pi-lifecycle-missing-"), secret, "private-runspace");
    try {
      const asyncDir = path.join(root, "run-missing");
      expectNoSecretInError(
        () =>
          transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: 0,
            mutate: (status) => status,
          }),
        secret,
        /persisted status was not found/,
      );
    } finally {
      fs.rmSync(path.dirname(path.dirname(root)), { recursive: true, force: true });
    }
  });

  it("recovers dead-owner continuation claims and leaves completed claims terminal", () => {
    const root = tempRoot("pi-lifecycle-claim-dead-");
    try {
      const asyncDir = path.join(root, "run-claim-dead");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-claim-dead",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 180,
        pause: { kind: "awaiting_supervisor", pausedAt: 170 },
        steps: [
          {
            agent: "worker",
            status: "paused",
            pause: { kind: "awaiting_supervisor", pausedAt: 170 },
          },
        ],
        lifecycle: {
          generation: 0,
          continuation: { claimToken: "claim-dead", claimedAt: 175, ownerPid: 8123 },
        },
      });
      const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
        kill: () => {
          const error = new Error("dead") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
        now: () => 250,
      });
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.liveness, "dead");
      assert.equal(recovered.status?.lifecycle?.continuation, undefined);
      assert.equal(readStatus(asyncDir)?.lifecycle?.continuation, undefined);
      assert.equal(readStatus(asyncDir)?.lifecycle?.generation, 1);

      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-claim-dead",
        mode: "single",
        state: "continued",
        startedAt: 100,
        steps: [{ agent: "worker", status: "continued" }],
        lifecycle: {
          generation: 1,
          continuation: {
            claimToken: "claim-done",
            claimedAt: 260,
            ownerPid: 8123,
            continuedAt: 270,
            continuationRunId: "resumed-1",
          },
        },
      });
      const completed = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
        kill: () => {
          const error = new Error("dead") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
      });
      assert.equal(completed.recovered, false);
      assert.equal(completed.liveness, "completed");
      assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.continuationRunId, "resumed-1");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers an indexed dead-owner claim without leaving a compatibility or map entry", () => {
    const root = tempRoot("pi-lifecycle-indexed-claim-dead-");
    try {
      const asyncDir = path.join(root, "run-indexed-claim-dead");
      const continuation = {
        phase: "reserved" as const,
        claimToken: "claim-indexed-dead",
        claimedAt: 175,
        ownerPid: 8123,
        continuationRunId: "resume-indexed-dead",
      };
      const status: AsyncStatus = {
        runId: "run-indexed-claim-dead",
        mode: "single",
        state: "paused",
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" }],
        lifecycle: {
          generation: 4,
          continuation,
          continuationsByIndex: { "0": continuation },
        },
      };
      const clearedLifecycle = withLifecycleContinuation(status, 0, undefined);
      assert.equal(Object.hasOwn(clearedLifecycle ?? {}, "continuation"), false);
      assert.equal(Object.hasOwn(clearedLifecycle ?? {}, "continuationsByIndex"), false);
      writeNormalizedLifecycleStatus(asyncDir, status);

      const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
        kill: () => {
          const error = new Error("dead") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
        now: () => 250,
      });

      assert.equal(recovered.recovered, true);
      assert.equal(recovered.liveness, "dead");
      const persisted = readStatus(asyncDir);
      assert.equal(persisted?.lifecycle?.continuation, undefined);
      assert.equal(persisted?.lifecycle?.continuationsByIndex, undefined);
      assert.equal(persisted?.lifecycle?.generation, 5);

      const target = resolveAsyncResumeTarget(
        { id: "run-indexed-claim-dead", index: 0 },
        { asyncDirRoot: root, resultsDir: path.join(root, "results") },
        { readOnly: true, requireSessionFile: false },
      );
      assert.equal(target.index, 0);
      assert.equal(target.agent, "worker");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechecks stale continuation recovery under lock without dropping same-generation settlement fields", () => {
    const root = tempRoot("pi-lifecycle-claim-toctou-");
    try {
      const asyncDir = path.join(root, "run-claim-toctou");
      const initialStatus = {
        runId: "run-claim-toctou",
        mode: "single" as const,
        state: "paused" as const,
        startedAt: 100,
        lastUpdate: 180,
        pause: { kind: "awaiting_supervisor" as const, pausedAt: 170 },
        steps: [
          {
            agent: "worker",
            status: "paused" as const,
            pause: { kind: "awaiting_supervisor" as const, pausedAt: 170 },
          },
        ],
        lifecycle: {
          generation: 0,
          continuation: {
            phase: "reserved" as const,
            claimToken: "claim-toctou",
            claimedAt: 175,
            ownerPid: 8123,
            continuationRunId: "resume-toctou",
          },
        },
      };
      writeNormalizedLifecycleStatus(asyncDir, initialStatus);
      let killCalls = 0;
      const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
        now: () => 250,
        kill: () => {
          killCalls += 1;
          if (killCalls === 1) {
            // Simulate a same-generation source-runner settlement after the
            // pre-lock inspection but before recovery acquires its lock.
            writeNormalizedLifecycleStatus(asyncDir, {
              ...initialStatus,
              state: "complete",
              endedAt: 300,
              lastUpdate: 300,
              error: "settled before stale recovery",
              pause: undefined,
              pid: undefined,
              steps: [
                {
                  ...initialStatus.steps[0],
                  status: "completed",
                  endedAt: 300,
                  exitCode: 0,
                  tokens: { input: 7, output: 3, total: 10 },
                },
              ],
            });
          }
          const error = new Error("dead") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
      });
      assert.equal(killCalls, 2, "recovery must recheck liveness after acquiring the lock");
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.liveness, "dead");
      const persisted = readStatus(asyncDir);
      assert.equal(persisted?.state, "complete");
      assert.equal(persisted?.endedAt, 300);
      assert.equal(persisted?.lastUpdate, 300, "recovery must not move lastUpdate backwards");
      assert.equal(persisted?.error, "settled before stale recovery");
      assert.equal(persisted?.steps?.[0]?.status, "complete");
      assert.equal(persisted?.steps?.[0]?.endedAt, 300);
      assert.equal(persisted?.steps?.[0]?.exitCode, 0);
      assert.deepEqual(persisted?.steps?.[0]?.tokens, { input: 7, output: 3, total: 10 });
      assert.equal(persisted?.lifecycle?.continuation, undefined);
      assert.equal(persisted?.lifecycle?.generation, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not clear a same-generation replacement continuation after stale preinspection", () => {
    const root = tempRoot("pi-lifecycle-claim-replacement-");
    try {
      const asyncDir = path.join(root, "run-claim-replacement");
      const initialStatus = {
        runId: "run-claim-replacement",
        mode: "single" as const,
        state: "paused" as const,
        startedAt: 100,
        lastUpdate: 180,
        steps: [{ agent: "worker", status: "paused" as const }],
        lifecycle: {
          generation: 0,
          continuation: {
            claimToken: "claim-old",
            claimedAt: 175,
            ownerPid: 8123,
            continuationRunId: "resume-old",
          },
        },
      };
      writeNormalizedLifecycleStatus(asyncDir, initialStatus);
      let killCalls = 0;
      const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
        now: () => 250,
        kill: (pid) => {
          killCalls += 1;
          assert.equal(pid, killCalls === 1 ? 8123 : 8124);
          if (killCalls === 1) {
            writeNormalizedLifecycleStatus(asyncDir, {
              ...initialStatus,
              lastUpdate: 300,
              lifecycle: {
                generation: 0,
                continuation: {
                  claimToken: "claim-new",
                  claimedAt: 295,
                  ownerPid: 8124,
                  continuationRunId: "resume-new",
                },
              },
            });
          }
          const error = new Error("dead") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
      });
      // Both owners are dead and neither continuation target exists, so the
      // under-lock stale recheck must itself report recovered:true. This call
      // stays conservative; a later call can inspect and recover claim-new.
      assert.equal(killCalls, 2, "recovery must recheck the replacement owner");
      assert.equal(recovered.recovered, false);
      assert.equal(recovered.liveness, "dead");
      assert.equal(recovered.status?.lifecycle?.continuation?.claimToken, "claim-new");
      assert.equal(recovered.status?.lifecycle?.continuation?.continuationRunId, "resume-new");
      assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.claimToken, "claim-new");
      assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.continuationRunId, "resume-new");
      assert.equal(readStatus(asyncDir)?.lastUpdate, 300);
      assert.equal(readStatus(asyncDir)?.lifecycle?.generation, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears dead-owner reserved continuations only when no target launch artifacts exist", () => {
    const root = tempRoot("pi-lifecycle-reserved-recovery-");
    try {
      const asyncDir = path.join(root, "run-reserved-recovery");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-reserved-recovery",
        mode: "single",
        state: "paused",
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" }],
        lifecycle: {
          generation: 0,
          continuation: {
            phase: "reserved",
            claimToken: "claim-reserved",
            claimedAt: 150,
            ownerPid: 9001,
            continuationRunId: "revived-1",
          },
        },
      });
      const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
        kill: () => {
          const error = new Error("dead") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
        now: () => 200,
        asyncDirRoot: root,
      });
      assert.equal(recovered.recovered, true);
      assert.equal(readStatus(asyncDir)?.lifecycle?.continuation, undefined);

      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-reserved-recovery",
        mode: "single",
        state: "paused",
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" }],
        lifecycle: {
          generation: 0,
          continuation: {
            phase: "launched",
            claimToken: "claim-launched",
            claimedAt: 150,
            ownerPid: 9002,
            continuationRunId: "revived-2",
          },
        },
      });
      fs.mkdirSync(path.join(root, "revived-2"), { recursive: true });
      const blocked = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
        kill: () => {
          const error = new Error("dead") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
        now: () => 220,
        asyncDirRoot: root,
      });
      assert.equal(blocked.recovered, false);
      assert.equal(blocked.liveness, "blocked");
      assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.continuationRunId, "revived-2");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes reserved continuations during launch gating before any target work begins", () => {
    const root = tempRoot("pi-lifecycle-finalize-reserved-");
    try {
      const asyncDir = path.join(root, "run-finalize-reserved");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-finalize-reserved",
        mode: "single",
        state: "paused",
        startedAt: 100,
        steps: [
          {
            agent: "worker",
            status: "paused",
            pause: { kind: "awaiting_supervisor", pausedAt: 140 },
          },
        ],
        pause: { kind: "awaiting_supervisor", pausedAt: 140 },
        lifecycle: {
          generation: 0,
          continuation: {
            phase: "reserved",
            claimToken: "claim-gate",
            claimedAt: 150,
            ownerPid: 9003,
            continuationRunId: "revived-gate",
          },
        },
      });
      const finalized = advanceLifecycleContinuation(
        asyncDir,
        0,
        "claim-gate",
        "revived-gate",
        true,
        () => 250,
      );
      assert.equal(finalized.changed || finalized.done, true);
      assert.equal(finalized.lost, false);
      const persisted = readStatus(asyncDir);
      assert.equal(persisted?.state, "complete");
      assert.equal(persisted?.steps?.[0]?.status, "complete");
      assert.equal(persisted?.lifecycle?.continuation?.phase, "completed");
      assert.equal(persisted?.lifecycle?.continuation?.continuationRunId, "revived-gate");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats already-finalized continuations as idempotent crash recovery", () => {
    const root = tempRoot("pi-lifecycle-finalize-idempotent-");
    try {
      const asyncDir = path.join(root, "run-finalize-idempotent");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-finalize-idempotent",
        mode: "single",
        state: "continued",
        startedAt: 100,
        steps: [{ agent: "worker", status: "continued" }],
        lifecycle: {
          generation: 0,
          continuation: {
            phase: "continued",
            claimToken: "claim-idempotent",
            claimedAt: 150,
            continuedAt: 240,
            continuationRunId: "revived-idempotent",
          },
        },
      });
      const finalized = advanceLifecycleContinuation(
        asyncDir,
        0,
        "claim-idempotent",
        "revived-idempotent",
        true,
        () => 260,
      );
      assert.equal(finalized.changed || finalized.done, true);
      assert.equal(finalized.lost, false);
      assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.continuedAt, 240);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects late continuation runners that lose their reservation before launch gating", () => {
    const root = tempRoot("pi-lifecycle-late-runner-");
    try {
      const asyncDir = path.join(root, "run-late-runner");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-late-runner",
        mode: "single",
        state: "paused",
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" }],
        lifecycle: {
          generation: 0,
          continuation: {
            phase: "reserved",
            claimToken: "claim-late",
            claimedAt: 150,
            ownerPid: 9003,
            continuationRunId: "revived-late",
          },
        },
      });
      transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: 0,
        mutate: (status) => ({
          ...status,
          lifecycle: withLifecycleContinuation(status, 0, undefined),
        }),
      });
      const late = advanceLifecycleContinuation(
        asyncDir,
        0,
        "claim-late",
        "revived-late",
        true,
        () => 250,
      );
      assert.equal(late.changed || late.done, false);
      assert.equal(late.lost, true);
      assert.equal(readStatus(asyncDir)?.state, "paused");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps continuation claims fail-closed for alive, unknown, stale-generation, and historical metadata", () => {
    const root = tempRoot("pi-lifecycle-claim-fail-closed-");
    try {
      const asyncDir = path.join(root, "run-claim-fail-closed");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-claim-fail-closed",
        mode: "single",
        state: "paused",
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" }],
        lifecycle: {
          generation: 0,
          continuation: { claimToken: "claim-live", claimedAt: 150, ownerPid: 9001 },
        },
      });
      const alive = recoverStaleLifecycleContinuationClaim(asyncDir, 0, { kill: () => true });
      assert.equal(alive.recovered, false);
      assert.equal(alive.liveness, "alive");
      assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.claimToken, "claim-live");

      const unknown = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
        kill: () => {
          const error = new Error("unknown") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      });
      assert.equal(unknown.recovered, false);
      assert.equal(unknown.liveness, "unknown");

      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-claim-fail-closed",
        mode: "single",
        state: "paused",
        startedAt: 100,
        steps: [{ agent: "worker", status: "paused" }],
        lifecycle: {
          generation: 0,
          continuation: { claimToken: "claim-race", claimedAt: 150, ownerPid: 9002 },
        },
      });
      transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: 0,
        mutate: (status) => ({
          ...status,
          lastUpdate: 190,
          lifecycle: withLifecycleContinuation(status, 0, {
            claimToken: "claim-new",
            claimedAt: 190,
            ownerPid: 9003,
          }),
        }),
      });
      const staleGeneration = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
        kill: (pid) => {
          const error = new Error("dead") as NodeJS.ErrnoException;
          error.code = pid === 9002 ? "ESRCH" : "EPERM";
          throw error;
        },
      });
      assert.equal(staleGeneration.recovered, false);
      assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.claimToken, "claim-new");

      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-claim-fail-closed",
            mode: "single",
            state: "paused",
            startedAt: 100,
            steps: [{ agent: "worker", status: "paused" }],
            lifecycle: {
              continuation: {
                claimToken: "claim-legacy",
                claimedAt: 150,
                privateRoot: "/private/root/secret",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      const historical = readStatus(asyncDir);
      assert.equal(historical?.lifecycle?.continuation?.claimToken, "claim-legacy");
      assert.equal(
        (historical?.lifecycle?.continuation as Record<string, unknown> | undefined)?.privateRoot,
        undefined,
      );
      const missingOwner = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
        kill: () => {
          throw new Error("should not be called");
        },
      });
      assert.equal(missingOwner.recovered, false);
      assert.equal(missingOwner.liveness, "missing-owner");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
