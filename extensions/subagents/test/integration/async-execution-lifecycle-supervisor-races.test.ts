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
  createEventBus,
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  makeMinimalCtx,
  makeSubagentState,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createSubagentExecutor, runSync } from "../support/single-execution-fixtures.ts";
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
  waitForMarker,
  waitForMockPiCall,
  waitForMockPiSignal,
  waitForPidsToExit,
  writeLifecycleLock,
} from "../support/async-execution-helpers.ts";
import {
  getAsyncConfigPath,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_ASYNC_STARTED_EVENT,
  type ResolvedControlConfig,
} from "../../src/shared/types.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import { appendSubagentTelemetryContinuation } from "../../src/shared/telemetry.ts";

function recordStartedPid(pids: Set<number>, payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const pid = "pid" in payload ? payload.pid : undefined;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) pids.add(pid);
}

function readPersistedPid(asyncDir: string): number | undefined {
  try {
    const status: unknown = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    );
    if (typeof status !== "object" || status === null || Array.isArray(status)) return undefined;
    const pid = "pid" in status ? status.pid : undefined;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function killPids(pids: readonly (number | undefined)[]): void {
  for (const pid of pids) {
    if (typeof pid !== "number" || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited before failure cleanup reached it.
    }
  }
}

describe("async execution lifecycle supervisor races", () => {
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
        maxSubagentDepth: 2,
      });

      const asyncDir = path.join(ASYNC_DIR, id);

      {
        const deadline = Date.now() + scaleTestTimeout(20_000);
        while (!fs.existsSync(readyMarker)) {
          if (Date.now() > deadline) assert.fail("Timed out waiting for mock child ready marker");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      requestAsyncInterrupt(asyncDir, { source: "tlhm-8typ-test" });

      await waitForAsyncState(asyncDir, "paused");

      const pausedStatusRaw = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const pausedGen = lifecycleGeneration(
        pausedStatusRaw as Parameters<typeof lifecycleGeneration>[0],
      );

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

      fs.writeFileSync(releaseMarker, "", "utf-8");

      const resultPath = await waitForAsyncResultFile(id);

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
        maxSubagentDepth: 2,
      });

      const asyncDir = path.join(ASYNC_DIR, id);

      {
        const deadline = Date.now() + scaleTestTimeout(20_000);
        while (!fs.existsSync(readyMarker)) {
          if (Date.now() > deadline) assert.fail("Timed out waiting for mock child ready marker");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      requestAsyncInterrupt(asyncDir, { source: "tlhm-8typ-r5-test" });

      await waitForAsyncState(asyncDir, "paused");

      const pausedStatusRaw = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const pausedGen = lifecycleGeneration(
        pausedStatusRaw as Parameters<typeof lifecycleGeneration>[0],
      );

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

      fs.writeFileSync(releaseMarker, "", "utf-8");

      const resultPath = await waitForAsyncResultFile(id);

      const resultPayload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

      assert.equal(
        resultPayload.state,
        "cancelled",
        "result artifact must reflect the adopted cancelled state, not stale paused",
      );
    },
  );

  it(
    "adopts canonical continuation telemetry when a resumed source settles concurrently",
    {
      skip:
        process.platform === "win32"
          ? "cross-process lifecycle race unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const markerDir = path.join(tempDir, "async-telemetry-adoption-markers");
      fs.mkdirSync(markerDir, { recursive: true });
      const readyMarker = path.join(markerDir, "source-ready");
      const releaseMarker = path.join(markerDir, "source-release");
      const continuationReadyMarker = path.join(markerDir, "continuation-ready");
      const continuationReleaseMarker = path.join(markerDir, "continuation-release");
      const sourceRunId = `async-telemetry-adoption-${Date.now().toString(36)}`;
      const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
      const sourceSessionFile = path.join(tempDir, "source-session.jsonl");
      const sourceRunnerPids = new Set<number>();
      const continuationRunnerPids = new Set<number>();
      const sourceEvents = createEventBus();
      sourceEvents.on(SUBAGENT_ASYNC_STARTED_EVENT, (payload) => {
        recordStartedPid(sourceRunnerPids, payload);
      });
      const continuationEvents = createEventBus();
      continuationEvents.on(SUBAGENT_ASYNC_STARTED_EVENT, (payload) => {
        recordStartedPid(continuationRunnerPids, payload);
      });
      const provenance = {
        tlhVersion: "race-tlh",
        piVersion: "race-pi",
        installGeneration: "race-generation",
        loadedAt: 123,
      };
      const controlConfig: ResolvedControlConfig = {
        enabled: true,
        needsAttentionAfterMs: 2_000,
        failedToolAttemptsBeforeAttention: 3,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      };

      // Keep the source child alive after the interrupt. The real resume action
      // can then commit the continuation edge and terminal source state before
      // the source runner performs its post-child terminal write.
      mockPi.onCall({
        ignoreSigint: true,
        ignoreSigterm: true,
        steps: [{ writeMarker: readyMarker }, { waitForMarker: releaseMarker }],
        output: "source work complete",
      });
      mockPi.onCall({
        steps: [
          { writeMarker: continuationReadyMarker },
          {
            waitForMarker: continuationReleaseMarker,
            jsonl: [events.assistantMessage("continuation work complete")],
          },
        ],
      });

      let continuationRunId: string | undefined;
      let cleanupFailure: Error | undefined;
      try {
        const sourceStart = executeAsyncSingle!(sourceRunId, {
          agent: "worker",
          task: "Source work for the telemetry race.",
          agentConfig: makeAgent("worker"),
          ctx: {
            pi: { events: sourceEvents },
            cwd: tempDir,
            currentSessionId: "session-123",
          },
          artifactConfig: {
            enabled: false,
            includeInput: false,
            includeOutput: false,
            includeJsonl: false,
            includeMetadata: false,
            cleanupDays: 7,
          },
          sessionRoot: path.join(tempDir, "sessions"),
          sessionFile: sourceSessionFile,
          maxSubagentDepth: 2,
          controlConfig,
          telemetryProvenance: provenance,
        });
        assert.equal(sourceStart.isError, undefined, sourceStart.content[0]?.text ?? "");

        await waitForMarker(readyMarker);
        requestAsyncInterrupt(sourceAsyncDir, { source: "async-telemetry-adoption-test" });
        await waitForAsyncState(sourceAsyncDir, "paused");

        assert.ok(createSubagentExecutor, "foreground executor fixture is available");
        assert.ok(runSync, "foreground execution fixture is available");
        const executor = createSubagentExecutor({
          pi: { events: continuationEvents, getSessionName: () => undefined },
          state: makeSubagentState({ baseCwd: tempDir }),
          config: { maxSubagentDepth: 2, control: controlConfig },
          tempArtifactsDir: tempDir,
          getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
          expandTilde: (value: string) => value,
          discoverAgents: () => ({ agents: [makeAgent("worker")] }),
          runSync,
          telemetryProvenance: provenance,
        });
        const resume = await executor.execute(
          "async-telemetry-adoption-resume",
          { action: "resume", id: sourceRunId, message: "Continue the source work." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(resume.isError, undefined, resume.content[0]?.text ?? "");
        continuationRunId = resume.details?.asyncId;
        assert.ok(continuationRunId, "resume must return the continuation run id");

        const targetConfig = JSON.parse(
          fs.readFileSync(getAsyncConfigPath(continuationRunId), "utf-8"),
        ) as {
          telemetry?: {
            provenance?: typeof provenance;
            lineage?: { continuationFrom?: { sourceRunId?: string; sourceStepIndex?: number } };
          };
        };
        assert.deepEqual(targetConfig.telemetry?.provenance, provenance);
        assert.deepEqual(targetConfig.telemetry?.lineage?.continuationFrom, {
          sourceRunId,
          sourceStepIndex: 0,
        });

        // Keep the continuation child live after the source adopts its terminal
        // telemetry. This makes the teardown race deterministic without sleeps.
        await waitForMarker(continuationReadyMarker);
        assert.equal(
          fs.existsSync(path.join(RESULTS_DIR, `${continuationRunId}.json`)),
          false,
          "continuation result must not exist while its child is deliberately held",
        );

        await waitForAsyncStatusPredicate(
          sourceAsyncDir,
          (status) =>
            status.state === "continued" &&
            status.telemetry?.lineage?.continuations?.some(
              (continuation) => continuation.continuationRunId === continuationRunId,
            ) === true,
          "source continuation terminal telemetry",
        );

        // The source runner is still draining its interrupted child. Releasing
        // it now forces the concurrent-terminal adoption path before result write.
        fs.writeFileSync(releaseMarker, "", "utf-8");
        const resultPath = await waitForAsyncResultFile(sourceRunId);
        const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
        const status = JSON.parse(
          fs.readFileSync(path.join(sourceAsyncDir, "status.json"), "utf-8"),
        ) as AsyncStatusPayload;

        assert.equal(status.state, "continued");
        assert.equal(result.state, "continued");
        assert.ok(status.telemetry, "source status must retain canonical telemetry");
        assert.deepEqual(result.telemetry, status.telemetry);
        assert.deepEqual(status.telemetry?.provenance, provenance);
        assert.deepEqual(status.telemetry?.lineage?.continuations, [
          { sourceStepIndex: 0, continuationRunId },
        ]);
        assert.equal(status.telemetry?.outcome?.state, "continued");
        assert.equal(status.telemetry?.steps[0]?.outcome?.state, "continued");

        const completionEvents: unknown[] = [];
        const completionEventsBus = createEventBus();
        completionEventsBus.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => {
          completionEvents.push(payload);
        });
        const watcher = createResultWatcher(
          { events: completionEventsBus },
          makeSubagentState({ currentSessionId: "session-123" }),
          RESULTS_DIR,
          60_000,
        );
        try {
          watcher.primeExistingResults();
          const deadline = Date.now() + scaleTestTimeout(10_000);
          while (
            !completionEvents.some(
              (payload) =>
                typeof payload === "object" &&
                payload !== null &&
                (payload as { runId?: unknown }).runId === sourceRunId,
            )
          ) {
            if (Date.now() > deadline)
              assert.fail("Timed out waiting for adopted source completion telemetry");
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        } finally {
          watcher.stopResultWatcher();
        }
        const completion = completionEvents.find(
          (payload): payload is AsyncResultPayload & { runId: string } =>
            typeof payload === "object" &&
            payload !== null &&
            (payload as { runId?: unknown }).runId === sourceRunId,
        );
        assert.ok(completion, "completion notification must include the source run");
        assert.deepEqual(completion.telemetry, status.telemetry);
        assert.deepEqual(completion.telemetry?.provenance, provenance);
        assert.deepEqual(completion.telemetry?.lineage?.continuations, [
          { sourceStepIndex: 0, continuationRunId },
        ]);
        assert.equal(completion.telemetry?.outcome?.state, "continued");

        // The source result is intentionally observed while the continuation is
        // still live. Release it only after all source telemetry assertions, then
        // wait for its own terminal artifact before teardown removes its directory.
        fs.writeFileSync(continuationReleaseMarker, "", "utf-8");
        const continuationResultPath = await waitForAsyncResultFile(continuationRunId);
        const continuationResult = JSON.parse(
          fs.readFileSync(continuationResultPath, "utf-8"),
        ) as AsyncResultPayload;
        assert.equal(continuationResult.state, "complete");
      } finally {
        // Release both deterministic gates before cleanup so an assertion failure
        // cannot strand either mock child. The normal path has observed both
        // result artifacts before deleting any run-owned files.
        fs.writeFileSync(releaseMarker, "", "utf-8");
        fs.writeFileSync(continuationReleaseMarker, "", "utf-8");

        const cleanupRunIds = [sourceRunId, continuationRunId].filter(
          (id): id is string => typeof id === "string",
        );
        const cleanupAsyncDirs = [
          sourceAsyncDir,
          ...(continuationRunId ? [path.join(ASYNC_DIR, continuationRunId)] : []),
        ];
        const cleanupTimeout = scaleTestTimeout(5_000);
        await Promise.all(
          cleanupRunIds.map((id) =>
            waitForAsyncResultFile(id, cleanupTimeout).catch(() => undefined),
          ),
        );

        const collectOwnedPids = (): number[] => {
          const pids = new Set<number>([
            ...sourceRunnerPids,
            ...continuationRunnerPids,
            ...startedMockPiPids(mockPi),
          ]);
          for (const asyncDir of cleanupAsyncDirs) {
            const pid = readPersistedPid(asyncDir);
            if (pid !== undefined) pids.add(pid);
          }
          return [...pids];
        };

        const requestOwnedStops = (): void => {
          for (const asyncDir of cleanupAsyncDirs) {
            if (!fs.existsSync(asyncDir)) continue;
            try {
              requestAsyncInterrupt(asyncDir, {
                source: "async-telemetry-adoption-test-cleanup",
              });
            } catch {
              // The run may have already exited or removed its control files.
            }
          }
        };
        const reapOwnedPids = async (): Promise<boolean> => {
          let ownedPids = collectOwnedPids();
          try {
            await waitForPidsToExit(ownedPids, "async telemetry adoption cleanup", cleanupTimeout);
            return true;
          } catch {
            // A failed fixture may still own a writer; stop it before considering removal.
          }
          requestOwnedStops();
          ownedPids = collectOwnedPids();
          killPids(ownedPids);
          try {
            await waitForPidsToExit(
              ownedPids,
              "async telemetry adoption forced cleanup",
              cleanupTimeout,
            );
            return true;
          } catch {
            return false;
          }
        };

        const reaped = await reapOwnedPids();
        if (!reaped) {
          cleanupFailure = new Error(
            "Async telemetry adoption cleanup could not reap every owned process; run files were left in place.",
          );
        } else {
          fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
          if (continuationRunId) {
            fs.rmSync(path.join(ASYNC_DIR, continuationRunId), { recursive: true, force: true });
          }
          fs.rmSync(path.join(RESULTS_DIR, `${sourceRunId}.json`), { force: true });
          if (continuationRunId) {
            fs.rmSync(path.join(RESULTS_DIR, `${continuationRunId}.json`), { force: true });
            fs.rmSync(getAsyncConfigPath(continuationRunId), { force: true });
          }
        }
      }
      if (cleanupFailure) throw cleanupFailure;
    },
  );

  it(
    "uses post-write canonical telemetry when a resume edge arrives while the source remains paused",
    {
      skip:
        process.platform === "win32"
          ? "cross-process lifecycle race unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const markerDir = path.join(tempDir, "async-telemetry-paused-edge-markers");
      fs.mkdirSync(markerDir, { recursive: true });
      const readyMarker = path.join(markerDir, "source-ready");
      const releaseMarker = path.join(markerDir, "source-release");
      const sourceRunId = `async-telemetry-paused-edge-${Date.now().toString(36)}`;
      const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
      const sessionId = "session-telemetry-paused-edge";
      const provenance = {
        tlhVersion: "paused-edge-tlh",
        piVersion: "paused-edge-pi",
        installGeneration: "paused-edge-generation",
        loadedAt: 321,
      };
      const controlConfig: ResolvedControlConfig = {
        enabled: true,
        needsAttentionAfterMs: 2_000,
        failedToolAttemptsBeforeAttention: 3,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      };

      mockPi.onCall({
        ignoreSigint: true,
        ignoreSigterm: true,
        steps: [{ writeMarker: readyMarker }, { waitForMarker: releaseMarker }],
        output: "source work complete",
      });

      try {
        const started = executeAsyncSingle!(sourceRunId, {
          agent: "worker",
          task: "Source work for the paused telemetry edge race.",
          agentConfig: makeAgent("worker"),
          ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: sessionId },
          artifactConfig: {
            enabled: false,
            includeInput: false,
            includeOutput: false,
            includeJsonl: false,
            includeMetadata: false,
            cleanupDays: 7,
          },
          sessionRoot: path.join(tempDir, "sessions"),
          maxSubagentDepth: 2,
          controlConfig,
          telemetryProvenance: provenance,
        });
        assert.equal(started.isError, undefined, started.content[0]?.text ?? "");

        await waitForMarker(readyMarker);
        requestAsyncInterrupt(sourceAsyncDir, { source: "paused-telemetry-edge-test" });
        const pausedStatus = await waitForAsyncStatusPredicate(
          sourceAsyncDir,
          (status) => status.state === "paused",
          "paused source before resume telemetry edge",
        );
        const continuationRunId = `${sourceRunId}-continuation`;
        const edge = appendSubagentTelemetryContinuation(pausedStatus.telemetry, {
          sourceStepIndex: 0,
          continuationRunId,
        });
        assert.ok(edge, "paused source status must already carry telemetry");
        const edgeAt = Date.now();
        const edgeTransition = transitionLifecycleStatus({
          asyncDir: sourceAsyncDir,
          expectedGeneration: lifecycleGeneration(pausedStatus),
          mutate: (status) => ({
            ...status,
            telemetry: edge,
            lastUpdate: edgeAt,
          }),
        });
        assert.equal(edgeTransition.status.state, "paused");
        assert.deepEqual(edgeTransition.status.telemetry?.lineage?.continuations, [
          { sourceStepIndex: 0, continuationRunId },
        ]);

        // The source is still paused: release it only after the resume actor's
        // lineage write. Its locked terminal write must carry this edge into all
        // terminal telemetry carriers.
        fs.writeFileSync(releaseMarker, "", "utf-8");
        const resultPath = await waitForAsyncResultFile(sourceRunId);
        const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
          state?: string;
          telemetry?: unknown;
        };
        const status = JSON.parse(
          fs.readFileSync(path.join(sourceAsyncDir, "status.json"), "utf-8"),
        ) as AsyncStatusPayload;
        assert.equal(status.state, "paused");
        assert.equal(result.state, "paused");
        assert.deepEqual(result.telemetry, status.telemetry);
        assert.deepEqual(status.telemetry?.provenance, provenance);
        assert.deepEqual(status.telemetry?.lineage?.continuations, [
          { sourceStepIndex: 0, continuationRunId },
        ]);
        assert.equal(status.telemetry?.outcome?.state, "paused");

        const completionEvents: unknown[] = [];
        const completionEventsBus = createEventBus();
        completionEventsBus.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => {
          completionEvents.push(payload);
        });
        const watcher = createResultWatcher(
          { events: completionEventsBus },
          makeSubagentState({ currentSessionId: sessionId }),
          RESULTS_DIR,
          60_000,
        );
        try {
          watcher.primeExistingResults();
          const deadline = Date.now() + scaleTestTimeout(10_000);
          while (
            !completionEvents.some(
              (payload) =>
                typeof payload === "object" &&
                payload !== null &&
                (payload as { runId?: unknown }).runId === sourceRunId,
            )
          ) {
            if (Date.now() > deadline)
              assert.fail("Timed out waiting for paused resume-edge completion telemetry");
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        } finally {
          watcher.stopResultWatcher();
        }
        const completion = completionEvents.find(
          (payload): payload is { runId: string; telemetry?: unknown } =>
            typeof payload === "object" &&
            payload !== null &&
            (payload as { runId?: unknown }).runId === sourceRunId,
        );
        assert.ok(completion, "completion notification must include the paused source run");
        assert.deepEqual(completion.telemetry, status.telemetry);
      } finally {
        fs.writeFileSync(releaseMarker, "", "utf-8");
        fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
        fs.rmSync(path.join(RESULTS_DIR, `${sourceRunId}.json`), { force: true });
      }
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
        maxSubagentDepth: 2,
      });

      const asyncDir2 = path.join(ASYNC_DIR, id);

      {
        const deadline = Date.now() + scaleTestTimeout(20_000);
        while (!fs.existsSync(task1ReadyMarker)) {
          if (Date.now() > deadline)
            assert.fail("Timed out waiting for task 1 ready marker (finding-1-parallel)");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      requestAsyncInterrupt(asyncDir2, { source: "finding1-parallel-test" });
      await waitForAsyncState(asyncDir2, "paused");

      const pausedStatusRaw2 = JSON.parse(
        fs.readFileSync(path.join(asyncDir2, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const pausedGen2 = lifecycleGeneration(
        pausedStatusRaw2 as Parameters<typeof lifecycleGeneration>[0],
      );

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

      fs.writeFileSync(task1ReleaseMarker, "", "utf-8");

      const resultPath2 = await waitForAsyncResultFile(id, scaleTestTimeout(30_000));

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
        maxSubagentDepth: 2,
      });

      const asyncDir = path.join(ASYNC_DIR, id);

      {
        const deadline = Date.now() + scaleTestTimeout(20_000);
        while (!fs.existsSync(child0ReadyMarker) || !fs.existsSync(child1ReadyMarker)) {
          if (Date.now() > deadline)
            assert.fail("Timed out waiting for both child ready markers (invariant pin)");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      requestAsyncInterrupt(asyncDir, { source: "invariant-pin-test" });
      await waitForAsyncState(asyncDir, "paused");

      const pausedStatusRaw = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const pausedGen = lifecycleGeneration(
        pausedStatusRaw as Parameters<typeof lifecycleGeneration>[0],
      );

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

      fs.writeFileSync(releaseMarker, "", "utf-8");

      const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(30_000));

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
