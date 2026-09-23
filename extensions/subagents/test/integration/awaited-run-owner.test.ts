/** Integration coverage for the opt-in awaited async-run owner. */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createEventBus,
  createMockPi,
  createTempDir,
  events as mockEvents,
  makeAgent,
  makeExtensionAPI,
  makeRunnerStep,
  makeSubagentState,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  waitForMockPiCall,
  waitForPidsToExit,
  startedMockPiPids,
} from "../support/async-execution-helpers.ts";
import {
  executeAsyncParallel,
  executeAsyncSingle,
} from "../../src/runs/background/async-execution.ts";
import {
  computeAwaitedHardDeadlineAt,
  createAwaitedRunOwner,
  type AwaitedRunResult,
} from "../../src/runs/background/awaited-run-owner.ts";
import {
  dispatchAwaitedRunCompletion,
  isAwaitedRun,
  isAwaitedRunOwner,
  registerAwaitedRun,
  unregisterAwaitedRun,
} from "../../src/runs/background/awaited-run-registry.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT,
  SUBAGENT_ASYNC_STARTED_EVENT,
} from "../../src/shared/types.ts";

const artifactConfig = {
  mode: "compact",
  enabled: false,
  includeInput: false,
  includeOutput: false,
  includeJsonl: false,
  includeTranscript: false,
  includeMetadata: false,
  includeChildEventProjections: false,
  cleanupDays: 7,
} as const;

function recordEvents() {
  const bus = createEventBus();
  const channels: string[] = [];
  const emit = bus.emit;
  bus.emit = (channel, payload) => {
    channels.push(channel);
    emit(channel, payload);
  };
  return { bus, channels };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function singleParams(
  bus: ReturnType<typeof createEventBus>,
  cwd: string,
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    agent: "worker",
    task: "Run the awaited child.",
    agentConfig: makeAgent("worker"),
    ctx: { pi: makeExtensionAPI({ events: bus }), cwd, currentSessionId: "session-awaited" },
    artifactConfig,
    shareEnabled: false,
    sessionRoot: path.join(cwd, "sessions", id),
    maxSubagentDepth: 2,
    ...overrides,
    awaited: true as const,
  };
}

describe("awaited async-run owner", () => {
  it("includes cleanup and artifact grace in the hard deadline calculation", () => {
    assert.equal(
      computeAwaitedHardDeadlineAt({
        deadlineAt: 100,
        cleanupGraceMs: 25,
        artifactGraceMs: 40,
        cleanupMaxWaitMs: 0,
      }),
      165,
    );
    assert.equal(
      computeAwaitedHardDeadlineAt({
        deadlineAt: 100,
        abortStartedAt: 200,
        cleanupGraceMs: 25,
        artifactGraceMs: 40,
        cleanupMaxWaitMs: 10,
      }),
      275,
    );
    assert.equal(
      computeAwaitedHardDeadlineAt({
        cleanupGraceMs: 25,
        artifactGraceMs: 40,
      }),
      undefined,
    );
  });

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
    tempDir = createTempDir("awaited-owner-");
    mockPi.reset();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("keeps the awaited poll handle referenced until the owner settles", async () => {
    const id = `awaited-poll-ref-${Date.now().toString(36)}`;
    let pollHandle: ReturnType<typeof setInterval> | undefined;
    let pollCleared = 0;
    const setPollInterval: typeof setInterval = (callback, delay, ...args) => {
      const handle = setInterval(callback, delay, ...args);
      pollHandle = handle;
      return handle;
    };
    const clearPollInterval: typeof clearInterval = (handle) => {
      pollCleared += 1;
      clearInterval(handle);
    };
    const owner = createAwaitedRunOwner({
      id,
      asyncDir: path.join(ASYNC_DIR, id),
      resultPath: path.join(RESULTS_DIR, `${id}.json`),
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "poll ref task") },
      events: recordEvents().bus,
      platform: "win32",
      pidLiveness: () => "alive",
      setInterval: setPollInterval,
      clearInterval: clearPollInterval,
    });
    try {
      owner.markSpawned(999_989);
      const handle = pollHandle;
      assert.ok(handle, "expected the awaited owner to start its poll interval");
      assert.equal(handle.hasRef(), true, "pending awaited owners must retain a referenced handle");
      await owner.fail("settle poll ref test");
      assert.equal(pollCleared, 1, "settled awaited owners must clear the poll handle");
    } finally {
      owner.dispose();
    }
  });

  it("awaits completion, keeps the internal status marker, and emits no detached notification", async () => {
    const id = `awaited-complete-${Date.now().toString(36)}`;
    const { bus, channels } = recordEvents();
    mockPi.onCall({ output: "awaited completion" });

    const result = await executeAsyncSingle(id, singleParams(bus, tempDir, id));

    assert.equal(result.details.mode, "single");
    assert.equal(result.details.runId, id);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0]?.terminationReason, "completed");
    assert.equal(result.details.results[0]?.finalOutput, "awaited completion");
    assert.equal("awaited" in result.details, false);
    assert.equal(result.details.results[0]?.terminalResult?.state, "completed");
    assert.equal(result.details.results[0]?.terminalResult?.facts.attempts.length, 1);
    assert.deepEqual(channels, [SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT]);

    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as { awaited?: boolean; state?: string };
    assert.equal(status.awaited, true);
    assert.equal(status.state, "complete");
    assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)), false);
  });

  it("retries an injected awaited claim failure and removes its sidecar", async () => {
    const id = `awaited-claim-retry-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "running",
        pid: 999_996,
        startedAt: Date.now(),
        lifecycle: { generation: 0 },
        steps: [{ agent: "worker", status: "running" }],
      }),
      "utf8",
    );
    let claimFailures = 1;
    const fsProxy = {
      existsSync: fs.existsSync.bind(fs),
      openSync(filePath: fs.PathLike, flags: string | number, mode?: string | number | null) {
        if (String(filePath) === `${resultPath}.claim` && claimFailures > 0) {
          claimFailures--;
          const error = new Error("simulated awaited claim failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return fs.openSync(filePath, flags, mode);
      },
      closeSync: fs.closeSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      unlinkSync: fs.unlinkSync.bind(fs),
    };
    const { bus, channels } = recordEvents();
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "claim retry task") },
      events: bus,
      expectedGeneration: 0,
      pollIntervalMs: 5,
      pidLiveness: () => "alive",
      fs: fsProxy,
    });
    owner.markSpawned(999_996);
    try {
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id,
          runId: id,
          asyncDir,
          sessionId: "session-awaited",
          mode: "single",
          state: "complete",
          generation: 0,
          agent: "worker",
          success: true,
          summary: "awaited claim retry",
          results: [
            {
              agent: "worker",
              output: "awaited claim retry",
              success: true,
              exitCode: 0,
              terminationReason: "completed",
            },
          ],
        }),
        "utf8",
      );
      const result = await owner.promise;
      assert.equal(result.details.results[0]?.finalOutput, "awaited claim retry");
      assert.equal(claimFailures, 0);
      assert.deepEqual(channels, [SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT]);
      assert.equal(fs.existsSync(resultPath), false);
      assert.equal(fs.existsSync(`${resultPath}.claim`), false);
    } finally {
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // The owner normally consumes the terminal artifact.
      }
      try {
        fs.unlinkSync(`${resultPath}.claim`);
      } catch {
        // The owner normally removes the claim sidecar with the artifact.
      }
    }
  });

  it("projects live status progress and skill warnings before terminal settlement", async () => {
    const id = `awaited-live-progress-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const startedAt = Date.now();
    const warning = "Skills not found: missing-live-skill";
    const { bus } = recordEvents();
    const updates: AwaitedRunResult[] = [];
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "running",
        pid: 999_997,
        startedAt,
        lastUpdate: startedAt,
        lifecycle: { generation: 0 },
        steps: [
          {
            agent: "worker",
            status: "running",
            startedAt,
            lastActivityAt: startedAt - 1_000,
            recentOutput: ["still working"],
            skills: ["available-live-skill"],
            skillsWarning: warning,
          },
        ],
      }),
      "utf-8",
    );
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "live progress task") },
      events: bus,
      expectedGeneration: 0,
      pollIntervalMs: 5,
      pidLiveness: () => "alive",
      onUpdate: (result) => {
        updates.push(result);
      },
    });
    owner.markSpawned(999_997);
    try {
      for (let attempt = 0; attempt < 100 && updates.length === 0; attempt++) await sleep(5);
      assert.ok(updates.length > 0, "expected a status-driven awaited progress update");
      const progress = updates[0]!.details.progress?.[0];
      assert.equal(progress?.status, "running");
      assert.equal(progress?.lastActivityAt, startedAt);
      assert.deepEqual(progress?.skills, ["available-live-skill"]);
      assert.equal(updates[0]!.details.results[0]?.skillsWarning, warning);

      const artifact = {
        id,
        runId: id,
        asyncDir,
        mode: "single",
        state: "complete",
        generation: 0,
        success: true,
        summary: "live task complete",
        results: [
          {
            agent: "worker",
            task: "live progress task",
            state: "complete",
            success: true,
            exitCode: 0,
            terminationReason: "completed",
            output: "live task complete",
            // Persisted envelopes are untrusted; malformed ticket IDs must not leak into results.
            ticketId: { malformed: true },
            skills: ["available-live-skill"],
            skillsWarning: warning,
          },
        ],
      };
      fs.writeFileSync(path.join(RESULTS_DIR, `${id}.json`), JSON.stringify(artifact), "utf-8");
      bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, artifact);
      const result = await owner.promise;
      assert.equal(result.details.results[0]?.skillsWarning, warning);
      assert.equal(result.details.results[0]?.finalOutput, "live task complete");
      assert.equal(result.details.results[0]?.ticketId, undefined);
    } finally {
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // The owner normally consumes the terminal artifact.
      }
    }
  });

  it("keeps a durable supervisor pause when parent abort races its lifecycle", async () => {
    const id = `awaited-pause-abort-race-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const startedAt = Date.now();
    const pause = {
      kind: "awaiting_supervisor",
      requestedAt: startedAt,
      pausedAt: startedAt + 1,
      summary: "Need a decision before continuing.",
    };
    const { bus } = recordEvents();
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "pausing",
        pid: 999_998,
        startedAt,
        lifecycle: { generation: 0 },
        pause,
        steps: [{ agent: "worker", status: "pausing", pause }],
      }),
      "utf-8",
    );
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "pause race") },
      events: bus,
      expectedGeneration: 0,
      pollIntervalMs: 5,
      pidLiveness: () => "alive",
    });
    owner.markSpawned(999_998);
    try {
      await owner.cancel();
      let settled = false;
      void owner.promise.then(() => {
        settled = true;
      });
      await sleep(20);
      assert.equal(settled, false, "a durable pause must not settle as cancellation");

      const artifact = {
        id,
        runId: id,
        asyncDir,
        mode: "single",
        state: "paused",
        generation: 0,
        success: true,
        summary: "Need a decision before continuing.",
        pause,
        results: [
          {
            agent: "worker",
            task: "pause race",
            state: "paused",
            success: false,
            exitCode: 0,
            interrupted: true,
            terminationReason: "paused",
            output: "Paused after interrupt.",
            pause,
          },
        ],
      };
      bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, artifact);
      const result = await owner.promise;
      assert.equal(result.isError, undefined);
      assert.equal(result.details.results[0]?.terminationReason, "paused");
      assert.equal(result.details.results[0]?.pause?.kind, "awaiting_supervisor");
    } finally {
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // The owner normally consumes the terminal artifact.
      }
    }
  });

  it("retains missing-skill warnings in awaited status and native results", async () => {
    const id = `awaited-skills-warning-${Date.now().toString(36)}`;
    const { bus } = recordEvents();
    mockPi.onCall({ output: "skill warning result" });

    const result = await executeAsyncSingle(
      id,
      singleParams(bus, tempDir, id, {
        skills: ["missing-awaited-skill"],
      }),
    );

    assert.equal(
      result.details.results[0]?.skillsWarning,
      "Skills not found: missing-awaited-skill",
    );
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as { steps?: Array<{ skillsWarning?: string }> };
    assert.equal(status.steps?.[0]?.skillsWarning, "Skills not found: missing-awaited-skill");
  });

  it("retires superseded owners before abort, deadline, poll, and spawn callbacks", async () => {
    const scenarios = ["abort", "deadline", "poll", "spawn"] as const;
    for (const scenario of scenarios) {
      const id = `awaited-superseded-${scenario}-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, id);
      const resultPath = path.join(RESULTS_DIR, `${id}.json`);
      const bus = recordEvents().bus;
      const controller = new AbortController();
      let pollStarted = 0;
      let pollCleared = 0;
      const setPollInterval: typeof setInterval = (callback, delay, ...args) => {
        pollStarted += 1;
        return setInterval(callback, delay, ...args);
      };
      const clearPollInterval: typeof clearInterval = (handle) => {
        pollCleared += 1;
        clearInterval(handle);
      };
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId: id,
          mode: "single",
          state: "running",
          startedAt: 1,
          lifecycle: { generation: 0 },
          steps: [{ agent: "worker", status: "running" }],
        }),
        "utf-8",
      );
      const owner = createAwaitedRunOwner({
        id,
        asyncDir,
        resultPath,
        mode: "single",
        plan: { kind: "single", task: makeRunnerStep("worker", "superseded lifecycle") },
        events: bus,
        expectedGeneration: 0,
        ...(scenario === "abort" ? { signal: controller.signal } : {}),
        ...(scenario === "deadline" ? { deadlineAt: Date.now() + 25 } : {}),
        ...(scenario === "poll" || scenario === "spawn"
          ? { setInterval: setPollInterval, clearInterval: clearPollInterval, pollIntervalMs: 5 }
          : {}),
      });
      if (scenario === "poll") owner.markSpawned(999_980);
      const replacement = createAwaitedRunOwner({
        id,
        asyncDir,
        resultPath,
        mode: "single",
        plan: { kind: "single", task: makeRunnerStep("worker", "replacement lifecycle") },
        events: bus,
        expectedGeneration: 0,
      });
      try {
        if (scenario === "abort") {
          controller.abort();
          await owner.cancel();
        } else if (scenario === "deadline") {
          await sleep(60);
        } else if (scenario === "spawn") {
          owner.markSpawned(999_981);
          await sleep(20);
        } else {
          await sleep(20);
        }
        const retiredResult = await owner.promise;
        assert.equal(retiredResult.isError, true);
        const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as {
          state?: string;
          lifecycle?: { generation?: number };
        };
        assert.equal(status.state, "running");
        assert.equal(status.lifecycle?.generation, 0);
        if (scenario === "poll") assert.ok(pollCleared > 0);
        if (scenario === "spawn") assert.equal(pollStarted, 0);

        bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
          id,
          runId: id,
          asyncDir,
          generation: 0,
          state: "complete",
          summary: "replacement completion",
        });
        const replacementResult = await Promise.race([
          replacement.promise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${scenario} replacement did not settle`)), 1_000),
          ),
        ]);
        assert.equal(replacementResult.details.runId, id);
      } finally {
        owner.dispose();
        replacement.dispose();
        fs.rmSync(asyncDir, { recursive: true, force: true });
        try {
          fs.unlinkSync(resultPath);
        } catch {
          // The replacement owner normally consumes no persisted artifact in this test.
        }
      }
    }
  });

  it("does not let a superseded owner consume a replacement completion", async () => {
    const id = `awaited-replacement-owner-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const { bus } = recordEvents();
    const ownerOptions = {
      id,
      asyncDir,
      resultPath,
      mode: "single" as const,
      plan: { kind: "single" as const, task: makeRunnerStep("worker", "replacement owner") },
      events: bus,
      expectedGeneration: 0,
    };
    const supersededOwner = createAwaitedRunOwner(ownerOptions);
    const replacementOwner = createAwaitedRunOwner(ownerOptions);
    try {
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ id, runId: id, asyncDir, generation: 0, state: "complete" }),
        "utf-8",
      );
      supersededOwner.dispose();
      assert.equal(fs.existsSync(resultPath), true);
      bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id,
        runId: id,
        asyncDir,
        generation: 0,
        state: "complete",
        summary: "replacement completion",
      });
      const replacementResult = await replacementOwner.promise;
      assert.equal(replacementResult.details.runId, id);
      const supersededSettled = await supersededOwner.promise.then(() => true);
      assert.equal(supersededSettled, true);
    } finally {
      supersededOwner.dispose();
      replacementOwner.dispose();
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // The replacement owner normally consumes the shared artifact.
      }
    }
  });

  it("retains a silent sink for correlated artifacts after synthetic settlement", async () => {
    const id = `awaited-late-sink-${Date.now().toString(36)}`;
    const { bus, channels } = recordEvents();
    const owner = createAwaitedRunOwner({
      id,
      asyncDir: path.join(ASYNC_DIR, id),
      resultPath: path.join(RESULTS_DIR, `${id}.json`),
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "late artifact") },
      events: bus,
      expectedGeneration: 0,
      pollIntervalMs: 5,
      cleanupGraceMs: 10,
      artifactGraceMs: 10,
    });
    try {
      const result = await owner.fail("synthetic owner failure");
      assert.equal(result.isError, true);
      assert.equal(isAwaitedRun(id), true);
      assert.equal(dispatchAwaitedRunCompletion(id, { id, runId: id, state: "complete" }), false);
      assert.equal(
        dispatchAwaitedRunCompletion(id, { id, runId: id, generation: 0, state: "complete" }),
        true,
      );
      assert.equal(
        dispatchAwaitedRunCompletion(id, { id, runId: id, generation: 0, state: "failed" }),
        true,
      );
      const replacementToken = registerAwaitedRun(id, () => true, 0);
      await sleep(50);
      assert.equal(isAwaitedRunOwner(id, replacementToken), true);
      unregisterAwaitedRun(id, 0, replacementToken);
      assert.deepEqual(channels, [SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT]);
    } finally {
      unregisterAwaitedRun(id);
      owner.dispose();
    }
  });

  it("silently absorbs a watcher-first late artifact after cancellation bumps generation", async () => {
    const id = `awaited-late-generation-sink-${Date.now().toString(36)}`;
    const sessionId = "session-late-generation-sink";
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        lifecycleArtifactVersion: 1,
        runId: id,
        sessionId,
        mode: "single",
        state: "running",
        startedAt: 100,
        lifecycle: { generation: 0 },
        steps: [{ agent: "worker", status: "running" }],
      }),
      "utf8",
    );

    const { bus } = recordEvents();
    const publicCompletions: unknown[] = [];
    bus.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => publicCompletions.push(data));
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "late generation sink") },
      events: bus,
      sessionId,
      expectedGeneration: 0,
      pollIntervalMs: 5,
      cleanupGraceMs: 0,
      artifactGraceMs: 250,
    });
    const state = makeSubagentState({ currentSessionId: sessionId });
    const watcher = createResultWatcher({ events: bus }, state, RESULTS_DIR);
    try {
      await owner.cancel();
      const ownerResult = await owner.promise;
      assert.equal(ownerResult.details.results[0]?.terminationReason, "cancelled");
      const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as {
        state?: string;
        lifecycle?: { generation?: number };
      };
      assert.equal(status.state, "cancelled");
      assert.equal(status.lifecycle?.generation, 1);

      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          lifecycleArtifactVersion: 1,
          id,
          runId: id,
          sessionId,
          asyncDir,
          mode: "single",
          state: "cancelled",
          generation: 1,
          agent: "worker",
          success: false,
          summary: "late cancelled artifact",
          results: [
            {
              agent: "worker",
              output: "late cancelled artifact",
              success: false,
              exitCode: 1,
              terminationReason: "cancelled",
            },
          ],
        }),
        "utf8",
      );
      // The awaited call has already returned. A watcher-first artifact from
      // the generation bumped by cancellation must be consumed by the bounded
      // sink instead of becoming a detached notification and wake.
      watcher.primeExistingResults();
      await sleep(100);
      assert.deepEqual(publicCompletions, []);
      assert.equal(fs.existsSync(resultPath), false);
    } finally {
      watcher.stopResultWatcher();
      unregisterAwaitedRun(id);
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // The watcher normally consumes the late artifact.
      }
    }
  });

  it("disposes a live owner without waiting for cleanup to settle", async () => {
    const id = `awaited-dispose-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const cleanupGroups: number[] = [];
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "running",
        pid: 999_990,
        startedAt: Date.now(),
        lifecycle: { generation: 0 },
        steps: [{ agent: "worker", status: "running" }],
      }),
      "utf-8",
    );
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "dispose task") },
      events: recordEvents().bus,
      expectedGeneration: 0,
      cleanupMaxWaitMs: 0,
      platform: "linux",
      cleanup: async (processGroupId) => {
        cleanupGroups.push(processGroupId);
        return await new Promise<never>(() => {});
      },
      pidLiveness: () => "alive",
    });
    owner.markSpawned(999_990);
    owner.dispose();
    try {
      const result = await Promise.race([
        owner.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("disposed owner did not settle")), 100),
        ),
      ]);
      assert.equal(result.isError, true);
      assert.equal(result.details.results[0]?.terminationReason, "process_exit");
      assert.equal(result.details.results[0]?.processCleanup?.terminated, false);
      assert.equal(result.details.results[0]?.processCleanup?.processGroupId, undefined);
      await sleep(0);
      assert.deepEqual(cleanupGroups, [999_990]);
    } finally {
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // No artifact is expected for a disposed owner.
      }
    }
  });

  it("awaits a failed child with the native error result shape", async () => {
    const id = `awaited-failed-${Date.now().toString(36)}`;
    const { bus, channels } = recordEvents();
    mockPi.onCall({ output: "failed output", exitCode: 1 });

    const result = await executeAsyncSingle(id, singleParams(bus, tempDir, id));

    assert.equal(result.isError, true);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0]?.finalOutput, "failed output");
    assert.equal(result.details.results[0]?.terminationReason, "process_exit");
    assert.deepEqual(channels, [SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT]);
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as { awaited?: boolean; state?: string };
    assert.equal(status.awaited, true);
    assert.equal(status.state, "failed");
  });

  it("maps parent abort to cancellation and verified process-group cleanup", async () => {
    const id = `awaited-abort-${Date.now().toString(36)}`;
    const { bus, channels } = recordEvents();
    const controller = new AbortController();
    mockPi.onCall({
      output: "child stopped by parent",
      ignoreSigint: true,
      keepAliveAfterFinalMessageMs: 250,
    });

    const pending = executeAsyncSingle(
      id,
      singleParams(bus, tempDir, id, { signal: controller.signal }),
    );
    await waitForMockPiCall(mockPi, 0);
    const childPid = startedMockPiPids(mockPi)[0];
    controller.abort();
    const result = await pending;

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Status: failed/);
    assert.equal(result.details.results[0]?.terminationReason, "cancelled");
    assert.equal(result.details.results[0]?.cancel?.summary, "Cancelled by parent abort.");
    assert.equal(result.details.results[0]?.processCleanup?.terminated, true);
    assert.deepEqual(channels, [SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT]);
    await waitForPidsToExit([childPid], "cancelled mock child");

    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as {
      awaited?: boolean;
      state?: string;
      pid?: number;
      steps?: Array<{ status?: string; terminationReason?: string }>;
    };
    assert.equal(status.awaited, true);
    assert.equal(status.state, "cancelled");
    assert.equal(status.pid, undefined);
    assert.equal(status.steps?.[0]?.status, "cancelled");
    assert.equal(status.steps?.[0]?.terminationReason, "cancelled");
  });

  it("returns a durable supervisor pause with the resume command lines", async () => {
    const id = `awaited-paused-${Date.now().toString(36)}`;
    const { bus, channels } = recordEvents();
    mockPi.onCall({
      jsonl: [
        mockEvents.toolStart("contact_supervisor", {
          reason: "need_decision",
          message: "Need a decision",
        }),
      ],
    });

    const result = await executeAsyncSingle(id, singleParams(bus, tempDir, id));

    assert.equal(result.isError, undefined);
    assert.equal(result.details.results[0]?.terminationReason, "paused");
    assert.equal(result.details.results[0]?.pause?.kind, "awaiting_supervisor");
    const pauseText = result.content[0]!.text;
    assert.match(pauseText, /Resume unchanged: subagent\(\{ action: "resume"/);
    assert.match(pauseText, /Resume with guidance: subagent\(\{ action: "resume"/);
    assert.match(pauseText, /Cancel: subagent\(\{ action: "interrupt"/);
    assert.deepEqual(channels, [SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT]);

    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as { awaited?: boolean; state?: string; pid?: number };
    assert.equal(status.awaited, true);
    assert.equal(status.state, "paused");
    assert.equal(status.pid, undefined);
  });

  it("awaits parallel siblings and preserves each child result", async () => {
    const id = `awaited-parallel-${Date.now().toString(36)}`;
    const { bus, channels } = recordEvents();
    mockPi.onCall({ matchArgIncludes: "first awaited sibling", output: "first sibling" });
    mockPi.onCall({ matchArgIncludes: "second awaited sibling", output: "second sibling" });

    const result = await executeAsyncParallel(id, {
      awaited: true as const,
      tasks: [
        { agent: "first", task: "first awaited sibling" },
        { agent: "second", task: "second awaited sibling" },
      ],
      concurrency: 2,
      agents: [makeAgent("first"), makeAgent("second")],
      ctx: {
        pi: makeExtensionAPI({ events: bus }),
        cwd: tempDir,
        currentSessionId: "session-awaited",
      },
      artifactConfig,
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    assert.equal(result.details.mode, "parallel");
    assert.equal(result.details.results.length, 2);
    assert.deepEqual(
      result.details.results
        .map((child) => ({ agent: child.agent, state: child.terminationReason }))
        .sort((left, right) => left.agent.localeCompare(right.agent)),
      [
        { agent: "first", state: "completed" },
        { agent: "second", state: "completed" },
      ],
    );
    assert.match(result.content[0]!.text, /Children: 2 completed/);
    assert.deepEqual(channels, [SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT]);
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as { awaited?: boolean; state?: string; steps?: Array<{ status?: string }> };
    assert.equal(status.awaited, true);
    assert.equal(status.state, "complete");
    assert.deepEqual(
      status.steps?.map((step) => step.status),
      ["complete", "complete"],
    );
  });

  it("cancels all parallel awaited siblings and cleans their process group", async () => {
    const id = `awaited-parallel-abort-${Date.now().toString(36)}`;
    const { bus, channels } = recordEvents();
    const controller = new AbortController();
    mockPi.onCall({
      matchArgIncludes: "first parallel abort sibling",
      output: "first stopped",
      ignoreSigint: true,
      keepAliveAfterFinalMessageMs: 500,
    });
    mockPi.onCall({
      matchArgIncludes: "second parallel abort sibling",
      output: "second stopped",
      ignoreSigint: true,
      keepAliveAfterFinalMessageMs: 500,
    });

    const pending = executeAsyncParallel(id, {
      awaited: true as const,
      tasks: [
        { agent: "first", task: "first parallel abort sibling" },
        { agent: "second", task: "second parallel abort sibling" },
      ],
      concurrency: 2,
      agents: [makeAgent("first"), makeAgent("second")],
      ctx: {
        pi: makeExtensionAPI({ events: bus }),
        cwd: tempDir,
        currentSessionId: "session-awaited-abort",
      },
      artifactConfig,
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
      signal: controller.signal,
    });
    await waitForMockPiCall(mockPi, 0);
    await waitForMockPiCall(mockPi, 1);
    const childPids = startedMockPiPids(mockPi);
    controller.abort();
    const result = await pending;

    assert.equal(result.isError, true);
    assert.equal(result.details.results.length, 2);
    assert.ok(result.details.results.every((child) => child.terminationReason === "cancelled"));
    assert.ok(result.details.results.every((child) => child.interrupted !== true));
    assert.ok(result.details.results.every((child) => child.pause === undefined));
    assert.ok(result.details.results.every((child) => child.processCleanup?.terminated === true));
    assert.deepEqual(channels, [SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT]);
    await waitForPidsToExit(childPids, "cancelled parallel mock children");
  });

  it("does not synthesize a terminal result before lifecycle finalization", async () => {
    const id = `awaited-finalization-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const startedAt = Date.now();
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "complete",
        startedAt,
        lifecycle: { generation: 0 },
      }),
      "utf-8",
    );
    const { bus } = recordEvents();
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "finalization task") },
      events: bus,
      expectedGeneration: 0,
      pollIntervalMs: 5,
      artifactGraceMs: 0,
      cleanupGraceMs: 250,
      pidLiveness: () => "dead",
    });
    owner.markSpawned(999_991);
    try {
      await sleep(25);
      let returned = false;
      void owner.promise.then(() => {
        returned = true;
      });
      await sleep(10);
      assert.equal(returned, false);

      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId: id,
          mode: "single",
          state: "cancelled",
          startedAt,
          endedAt: Date.now(),
          lifecycle: { generation: 1 },
          cancel: { summary: "Cancelled by parent abort.", cancelledAt: Date.now() },
          error: "Cancelled by parent abort.",
          steps: [{ agent: "worker", status: "cancelled", terminationReason: "cancelled" }],
        }),
        "utf-8",
      );
      const result = await owner.promise;
      assert.equal(result.isError, true);
      assert.equal(result.details.results[0]?.terminationReason, "cancelled");
    } finally {
      owner.dispose();
    }
  });

  it("settles a failed result when a runner disappears without final artifacts", async () => {
    const id = `awaited-abandoned-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "running",
        startedAt: Date.now(),
        lifecycle: { generation: 0 },
        steps: [{ agent: "worker", status: "running" }],
      }),
      "utf-8",
    );
    const { bus } = recordEvents();
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "abandoned task") },
      events: bus,
      expectedGeneration: 0,
      pollIntervalMs: 5,
      cleanupGraceMs: 20,
      pidLiveness: () => "dead",
    });
    owner.markSpawned(999_992);
    const result = await Promise.race([
      owner.promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("abandoned owner did not settle")), 1_000),
      ),
    ]);
    assert.equal(result.isError, true);
    assert.equal(result.details.results[0]?.terminationReason, "process_exit");
    owner.dispose();
  });

  it("preserves a persisted role timeout when the awaited runner disappears", async () => {
    const id = `awaited-abandoned-role-timeout-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const startedAt = Date.now();
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "running",
        startedAt,
        lifecycle: { generation: 0 },
        // The runner can die after a role step is persisted as timed out but
        // before it writes the terminal run artifact.
        steps: [
          {
            agent: "worker",
            status: "running",
            startedAt,
            timeoutMs: 100,
            deadlineAt: startedAt + 100,
            timedOut: true,
          },
        ],
      }),
      "utf-8",
    );
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: {
        kind: "single",
        task: makeRunnerStep("worker", "role timeout abandoned", {
          timeoutMs: 100,
          timeoutOwner: "role",
        }),
      },
      events: recordEvents().bus,
      expectedGeneration: 0,
      pollIntervalMs: 5,
      cleanupGraceMs: 20,
      pidLiveness: () => "dead",
    });
    owner.markSpawned(999_994);
    try {
      const result = await Promise.race([
        owner.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("role-timeout owner did not settle")), 1_000),
        ),
      ]);
      assert.equal(result.isError, true);
      // A child role timeout must not be promoted to the run-level marker.
      assert.equal(result.details.timedOut, undefined);
      assert.equal(result.details.results[0]?.timedOut, true);
      assert.equal(result.details.results[0]?.terminationReason, "timed_out");
    } finally {
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // No artifact is expected for a dead runner fallback.
      }
    }
  });

  it("settles a wedged runner at the deadline with bounded timeout diagnostics", async () => {
    const id = `awaited-timeout-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const startedAt = Date.now();
    const deadlineAt = startedAt + 30;
    const cleanupGroups: number[] = [];
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "running",
        startedAt,
        deadlineAt,
        lifecycle: { generation: 0 },
        steps: [{ agent: "worker", status: "running", startedAt }],
      }),
      "utf-8",
    );
    const { bus } = recordEvents();
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "wedged task") },
      events: bus,
      expectedGeneration: 0,
      deadlineAt,
      pollIntervalMs: 5,
      artifactGraceMs: 0,
      cleanupGraceMs: 25,
      cleanupMaxWaitMs: 25,
      platform: process.platform,
      cleanup: async (processGroupId) => {
        cleanupGroups.push(processGroupId);
        return {
          supported: true,
          attempted: true,
          terminated: true,
          processGroupId,
          signals: ["SIGTERM"],
        };
      },
      pidLiveness: () => "alive",
    });
    owner.markSpawned(999_993);
    try {
      const result = await Promise.race([
        owner.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed-out owner did not settle")), 1_000),
        ),
      ]);
      assert.equal(result.isError, true);
      assert.equal(result.details.timedOut, true);
      assert.equal(result.details.results[0]?.timedOut, true);
      assert.equal(result.details.results[0]?.terminationReason, "timed_out");
      assert.equal(result.details.results[0]?.processCleanup?.supported, true);
      assert.equal(result.details.results[0]?.processCleanup?.processGroupId, 999_993);
      assert.deepEqual(cleanupGroups, [999_993]);
      assert.match(result.content[0]!.text, /Subagent timed out before finalization\./);

      const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as {
        state?: string;
        timedOut?: boolean;
        error?: string;
      };
      assert.equal(status.state, "failed");
      assert.equal(status.timedOut, true);
      assert.equal(status.error, "Subagent timed out before finalization.");
    } finally {
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // No artifact is expected for a wedged runner.
      }
    }
  });

  it("does not return from timeout until injected cleanup has finalized", async () => {
    const id = `awaited-timeout-order-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const startedAt = Date.now();
    const deadlineAt = startedAt + 25;
    const order: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupFinished = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "running",
        pid: 999_995,
        startedAt,
        deadlineAt,
        lifecycle: { generation: 0 },
        steps: [{ agent: "worker", status: "running", startedAt }],
      }),
      "utf-8",
    );
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "timeout order") },
      events: recordEvents().bus,
      expectedGeneration: 0,
      deadlineAt,
      pollIntervalMs: 5,
      artifactGraceMs: 0,
      cleanupGraceMs: 250,
      platform: "linux",
      cleanup: async (processGroupId) => {
        order.push(`cleanup-start:${processGroupId}`);
        await cleanupFinished;
        order.push("cleanup-end");
        return {
          supported: true,
          attempted: true,
          terminated: true,
          processGroupId,
        };
      },
      pidLiveness: () => "alive",
    });
    owner.markSpawned(999_995);
    try {
      await sleep(60);
      assert.deepEqual(order, ["cleanup-start:999995"]);
      let returned = false;
      void owner.promise.then(() => {
        returned = true;
      });
      await sleep(20);
      assert.equal(returned, false);

      releaseCleanup();
      const result = await owner.promise;
      assert.deepEqual(order, ["cleanup-start:999995", "cleanup-end"]);
      assert.equal(result.details.timedOut, true);
      assert.equal(result.details.results[0]?.processCleanup?.terminated, true);
    } finally {
      releaseCleanup();
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // The owner normally consumes the result artifact.
      }
    }
  });

  it("does not return from external interrupt until injected cleanup has finalized", async () => {
    const id = `awaited-interrupt-order-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const controller = new AbortController();
    const order: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupFinished = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "running",
        pid: 999_996,
        startedAt: Date.now(),
        lifecycle: { generation: 0 },
        steps: [{ agent: "worker", status: "running" }],
      }),
      "utf-8",
    );
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "interrupt order") },
      events: recordEvents().bus,
      expectedGeneration: 0,
      signal: controller.signal,
      pollIntervalMs: 5,
      artifactGraceMs: 0,
      cleanupGraceMs: 250,
      platform: "linux",
      cleanup: async (processGroupId) => {
        order.push(`cleanup-start:${processGroupId}`);
        await cleanupFinished;
        order.push("cleanup-end");
        return {
          supported: true,
          attempted: true,
          terminated: true,
          processGroupId,
        };
      },
      pidLiveness: () => "alive",
    });
    owner.markSpawned(999_996);
    try {
      controller.abort();
      await sleep(20);
      assert.deepEqual(order, ["cleanup-start:999996"]);
      let returned = false;
      void owner.promise.then(() => {
        returned = true;
      });
      await sleep(20);
      assert.equal(returned, false);

      releaseCleanup();
      const result = await owner.promise;
      assert.deepEqual(order, ["cleanup-start:999996", "cleanup-end"]);
      assert.equal(result.isError, true);
      assert.equal(result.details.results[0]?.terminationReason, "cancelled");
      assert.equal(result.details.results[0]?.processCleanup?.terminated, true);
    } finally {
      releaseCleanup();
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // The owner normally consumes the result artifact.
      }
    }
  });

  it("forces a bounded result when cleanup itself wedges past the hard deadline", async () => {
    const id = `awaited-hard-deadline-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const startedAt = Date.now();
    const deadlineAt = startedAt + 20;
    const cleanupGroups: number[] = [];
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "running",
        pid: 999_997,
        startedAt,
        deadlineAt,
        lifecycle: { generation: 0 },
        steps: [{ agent: "worker", status: "running", startedAt }],
      }),
      "utf-8",
    );
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "hard deadline") },
      events: recordEvents().bus,
      expectedGeneration: 0,
      deadlineAt,
      pollIntervalMs: 5,
      artifactGraceMs: 0,
      cleanupGraceMs: 25,
      cleanupMaxWaitMs: 25,
      platform: "linux",
      cleanup: async (processGroupId) => {
        cleanupGroups.push(processGroupId);
        return await new Promise<never>(() => {});
      },
      pidLiveness: () => "alive",
    });
    owner.markSpawned(999_997);
    try {
      const result = await Promise.race([
        owner.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("hard-deadline owner did not settle")), 1_000),
        ),
      ]);
      assert.equal(result.isError, true);
      assert.equal(result.details.timedOut, true);
      assert.equal(result.details.results[0]?.timedOut, true);
      assert.equal(result.details.results[0]?.terminationReason, "timed_out");
      assert.equal(result.details.results[0]?.processCleanup?.terminated, false);
      assert.equal(result.details.results[0]?.processCleanup?.processGroupId, undefined);
      assert.deepEqual(cleanupGroups, [999_997]);
      assert.match(
        result.content[0]!.text,
        /hard deadline before process-group cleanup was confirmed/,
      );
      const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as {
        state?: string;
        timedOut?: boolean;
      };
      assert.equal(status.state, "failed");
      assert.equal(status.timedOut, true);
    } finally {
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // No artifact is expected for a wedged runner.
      }
    }
  });

  it("bounds malformed artifact projections instead of rejecting the awaited call", async () => {
    const id = `awaited-malformed-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const startedAt = Date.now();
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "complete",
        startedAt,
        endedAt: startedAt + 1,
        lifecycle: { generation: 0 },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        id,
        runId: id,
        asyncDir,
        mode: "single",
        state: "complete",
        generation: 0,
        results: [{ agent: "worker", success: true, output: "malformed projection" }],
      }),
      "utf-8",
    );
    const bus = {
      on: () => () => {
        throw new Error("unsubscribe failed");
      },
      emit: () => {},
    };
    const malformedPlan = {
      kind: "single",
      get task(): never {
        throw new Error("malformed plan task");
      },
    } as never;
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: malformedPlan,
      events: bus,
      expectedGeneration: 0,
      pollIntervalMs: 5,
      artifactGraceMs: 0,
    });
    try {
      owner.markSpawned(999_994);
      const result = await Promise.race([
        owner.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("malformed artifact owner did not settle")), 1_000),
        ),
      ]);
      assert.equal(result.isError, true);
      assert.deepEqual(result.details.results, []);
      assert.match(result.content[0]!.text, /Awaited run result could not be projected/);
    } finally {
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // The owner normally consumes the malformed artifact.
      }
    }
  });

  it("keeps per-child usage and cancellation projections distinct", async () => {
    const id = `awaited-projection-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "parallel",
        state: "cancelled",
        startedAt: 1,
        endedAt: 2,
        lifecycle: { generation: 0 },
        steps: [
          {
            agent: "first",
            status: "complete",
            tokens: { input: 2, output: 3, total: 5 },
            totalCost: { inputTokens: 2, outputTokens: 3, costUsd: 0.2 },
          },
          {
            agent: "second",
            status: "cancelled",
            tokens: { input: 7, output: 11, total: 18 },
            totalCost: { inputTokens: 7, outputTokens: 11, costUsd: 0.7 },
          },
        ],
      }),
      "utf-8",
    );
    const { bus } = recordEvents();
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "parallel",
      plan: {
        kind: "parallel",
        tasks: [
          makeRunnerStep("first", "first projection"),
          makeRunnerStep("second", "second projection"),
        ],
      },
      events: bus,
      expectedGeneration: 0,
    });
    bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id,
      runId: id,
      asyncDir,
      mode: "parallel",
      state: "cancelled",
      generation: 0,
      success: false,
      summary: "Cancelled by parent abort.",
      cancel: { summary: "Cancelled by parent abort.", cancelledAt: 3 },
      totalTokens: { input: 100, output: 200, total: 300 },
      results: [
        {
          agent: "first",
          state: "complete",
          success: true,
          output: "first completed",
          exitCode: 0,
          terminationReason: "not-a-valid-reason",
        },
        {
          agent: "second",
          state: "cancelled",
          success: false,
          output: "cancelled",
          interrupted: true,
          exitCode: 1,
        },
      ],
    });
    const result = await owner.promise;
    assert.deepEqual(
      result.details.results.map((child) => ({
        usage: child.usage,
        interrupted: child.interrupted,
        terminationReason: child.terminationReason,
      })),
      [
        {
          usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.2, turns: 0 },
          interrupted: undefined,
          terminationReason: "completed",
        },
        {
          usage: { input: 7, output: 11, cacheRead: 0, cacheWrite: 0, cost: 0.7, turns: 0 },
          interrupted: undefined,
          terminationReason: "cancelled",
        },
      ],
    );
    assert.deepEqual(result.details.totalChildUsage, {
      input: 100,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    });
    assert.match(result.content[0]!.text, /Children: 1 completed, 1 failed/);
  });

  it("settles an awaited launch failure through the native error envelope", async () => {
    const id = `awaited-launch-failure-${Date.now().toString(36)}`;
    const { bus } = recordEvents();
    const result = await executeAsyncSingle(
      id,
      singleParams(bus, tempDir, id, { cwd: path.join(tempDir, "missing-cwd") }),
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.mode, "single");
    assert.match(result.content[0]!.text, /Failed to start async run/);
  });

  it("settles from a result artifact already consumed by the watcher", async () => {
    const id = `awaited-watcher-first-${Date.now().toString(36)}`;
    const sessionId = "session-watcher-first";
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        lifecycleArtifactVersion: 1,
        runId: id,
        sessionId,
        mode: "single",
        state: "complete",
        lifecycle: { generation: 0 },
      }),
      "utf-8",
    );

    const { bus, channels } = recordEvents();
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "watcher-first task") },
      events: bus,
      sessionId,
      expectedGeneration: 0,
    });
    const state = makeSubagentState({ currentSessionId: sessionId });
    const watcher = createResultWatcher({ events: bus }, state, RESULTS_DIR);
    try {
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          lifecycleArtifactVersion: 1,
          id,
          runId: id,
          sessionId,
          asyncDir,
          mode: "single",
          state: "complete",
          generation: 0,
          agent: "worker",
          success: true,
          summary: "watcher consumed this artifact first",
          results: [
            {
              agent: "worker",
              output: "watcher consumed this artifact first",
              success: true,
              exitCode: 0,
              terminationReason: "completed",
            },
          ],
        }),
        "utf-8",
      );

      // The owner is registered but not started, so this prime is deterministically
      // the first consumer. It models a watcher winning before the child-start
      // publication/owner polling turn.
      watcher.primeExistingResults();
      const result = await Promise.race([
        owner.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watcher-first owner did not settle")), 5_000),
        ),
      ]);

      assert.equal(result.details.results[0]?.finalOutput, "watcher consumed this artifact first");
      assert.equal(result.details.results[0]?.terminationReason, "completed");
      assert.deepEqual(channels, [SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT]);
      assert.equal(fs.existsSync(resultPath), false);
    } finally {
      watcher.stopResultWatcher();
      owner.dispose();
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // The owner/watcher normally removes the artifact; cleanup is best effort.
      }
    }
  });

  it("consumes a watcher-first artifact from a later lifecycle generation privately", async () => {
    const id = `awaited-watcher-later-generation-${Date.now().toString(36)}`;
    const sessionId = "session-watcher-later-generation";
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        lifecycleArtifactVersion: 1,
        runId: id,
        sessionId,
        mode: "single",
        state: "failed",
        startedAt: 100,
        endedAt: 200,
        lifecycle: { generation: 1 },
        steps: [{ agent: "worker", status: "failed", endedAt: 200 }],
      }),
      "utf-8",
    );

    const { bus } = recordEvents();
    const publicCompletions: unknown[] = [];
    bus.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => publicCompletions.push(data));
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "later generation") },
      events: bus,
      sessionId,
      expectedGeneration: 0,
    });
    const state = makeSubagentState({ currentSessionId: sessionId });
    const watcher = createResultWatcher({ events: bus }, state, RESULTS_DIR);
    try {
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          lifecycleArtifactVersion: 1,
          id,
          runId: id,
          sessionId,
          asyncDir,
          mode: "single",
          state: "failed",
          generation: 1,
          awaited: true,
          agent: "worker",
          success: false,
          summary: "later generation failed",
          results: [
            {
              agent: "worker",
              output: "later generation failed",
              success: false,
              exitCode: 1,
              terminationReason: "process_exit",
            },
          ],
        }),
        "utf-8",
      );
      // No owner poll or child-start event runs first: the watcher must hand
      // this generation to the still-live owner from its registry entry.
      watcher.primeExistingResults();
      const result = await Promise.race([
        owner.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("later-generation owner did not settle")), 5_000),
        ),
      ]);
      assert.equal(result.details.results[0]?.finalOutput, "later generation failed");
      assert.equal(result.details.results[0]?.terminationReason, "process_exit");
      assert.deepEqual(publicCompletions, []);
      assert.equal(fs.existsSync(resultPath), false);
      watcher.primeExistingResults();
      await sleep(50);
      assert.deepEqual(publicCompletions, []);
    } finally {
      watcher.stopResultWatcher();
      owner.dispose();
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // The owner/watcher normally removes the artifact; cleanup is best effort.
      }
    }
  });

  it("closes the owner completion hook before the awaited continuation resumes", async () => {
    const id = `awaited-order-${Date.now().toString(36)}`;
    const { bus, channels } = recordEvents();
    const order: string[] = [];
    bus.on(SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT, () => order.push("completion"));
    mockPi.onCall({ output: "ordered" });

    const pending = executeAsyncSingle(id, singleParams(bus, tempDir, id));
    const result = await pending;
    order.push("awaited-return");

    assert.equal(result.details.results[0]?.finalOutput, "ordered");
    assert.deepEqual(order, ["completion", "awaited-return"]);
    assert.deepEqual(channels, [SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT]);
    assert.equal(channels.includes(SUBAGENT_ASYNC_COMPLETE_EVENT), false);
  });
});
