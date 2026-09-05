/**
 * Integration tests for async execution – interrupt, timeout, hard-kill,
 * drain/cleanup, and relocated supervisor lifecycle tests.
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
import { deliverInterruptRequest } from "../../src/runs/background/control-channel.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import {
  transitionLifecycleStatus,
  withLifecycleContinuation,
  lifecycleGeneration,
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
    "interrupts every active async parallel child",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      mockPi.onCall({ delay: 5_000, output: "one done" });
      mockPi.onCall({ delay: 5_000, output: "two done" });
      mockPi.onCall({ delay: 5_000, output: "three done" });
      const id = `async-interrupt-parallel-${Date.now().toString(36)}`;
      executeAsyncParallel(id, {
        tasks: [
          {
            agent: "one",
            task: "Wait",
            acceptance: { level: "checked", criteria: ["Complete one"] },
          },
          {
            agent: "two",
            task: "Wait",
            acceptance: { level: "checked", criteria: ["Complete two"] },
          },
          {
            agent: "three",
            task: "Wait",
            acceptance: { level: "checked", criteria: ["Complete three"] },
          },
        ],
        concurrency: 3,
        agents: [makeAgent("one"), makeAgent("two"), makeAgent("three")],
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

      await waitForMockPiCall(mockPi, 2);
      const asyncDir = path.join(ASYNC_DIR, id);
      const statusPath = path.join(asyncDir, "status.json");
      const statusBeforeInterrupt = JSON.parse(
        fs.readFileSync(statusPath, "utf-8"),
      ) as AsyncStatusPayload & {
        pid?: number;
      };
      deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

      // 30s base: spawns 3 parallel children; extra headroom for slow runners.
      const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(30_000));
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
      const eventLog = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
      assert.equal(payload.state, "paused");
      assert.equal(payload.success, false);
      assert.deepEqual(
        payload.results.map((result) => result.acceptance?.status),
        ["skipped", "skipped", "skipped"],
      );
      assert.deepEqual(
        payload.results.map((result) => result.terminationReason),
        ["paused", "paused", "paused"],
      );
      assert.deepEqual(
        status.steps?.map((step) => step.status),
        ["paused", "paused", "paused"],
      );
      assert.deepEqual(
        status.steps?.map((step) => step.terminationReason),
        ["paused", "paused", "paused"],
      );
      assert.deepEqual(
        status.steps?.map((step) => step.acceptance?.status),
        ["skipped", "skipped", "skipped"],
      );
      assert.match(eventLog, /"type":"subagent.step.paused"/);
      assert.doesNotMatch(eventLog, /"type":"subagent.parallel.completed"/);
      assert.equal(mockPi.callCount(), 3);
    },
  );

  it(
    "parallel interrupt: each paused child retains its own discovered session file (F1+F2)",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      // Opt in to the mock's --session-dir file creation so the runner has a
      // discoverable per-child session file to track. Restored in finally so no
      // other test's token-tracking behavior is perturbed.
      const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
      process.env.MOCK_PI_SESSION_DIR_FILE = "1";
      try {
        mockPi.onCall({ delay: 5_000, output: "alpha done" });
        mockPi.onCall({ delay: 5_000, output: "beta done" });
        const sessionRoot = path.join(tempDir, "sessions");
        fs.mkdirSync(sessionRoot, { recursive: true });
        const id = `async-interrupt-parallel-session-${Date.now().toString(36)}`;
        executeAsyncParallel(id, {
          tasks: [
            {
              agent: "alpha",
              task: "Wait",
              acceptance: { level: "checked", criteria: ["Complete alpha"] },
            },
            {
              agent: "beta",
              task: "Wait",
              acceptance: { level: "checked", criteria: ["Complete beta"] },
            },
          ],
          concurrency: 2,
          agents: [makeAgent("alpha"), makeAgent("beta")],
          ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-f1f2" },
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
          sessionRoot,
        });

        // Wait for both children to be running before delivering the interrupt.
        await waitForMockPiCall(mockPi, 1);
        const asyncDir = path.join(ASYNC_DIR, id);
        const statusPath = path.join(asyncDir, "status.json");
        const statusBeforeInterrupt = JSON.parse(
          fs.readFileSync(statusPath, "utf-8"),
        ) as AsyncStatusPayload & {
          pid?: number;
        };
        deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

        // 30s base: spawns 2 parallel children; extra headroom for slow runners.
        const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(30_000));
        const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
        const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;

        // Both children must be paused with skipped acceptance.
        assert.deepEqual(
          status.steps?.map((s) => s.status),
          ["paused", "paused"],
        );
        assert.deepEqual(
          status.steps?.map((s) => s.acceptance?.status),
          ["skipped", "skipped"],
        );
        assert.equal(payload.state, "paused");

        // F1: each paused child in the status file has its OWN distinct session file.
        const stepSessionFiles = status.steps?.map((s) => s.sessionFile);
        assert.ok(stepSessionFiles?.[0], "paused child 0 must have a session file in status");
        assert.ok(stepSessionFiles?.[1], "paused child 1 must have a session file in status");
        assert.notEqual(
          stepSessionFiles?.[0],
          stepSessionFiles?.[1],
          "each paused child must have its OWN session file, not a shared one",
        );

        // F2: the result artifact also carries each child's discovered session file.
        const resultSessionFiles = payload.results.map((r) => r.sessionFile);
        assert.ok(resultSessionFiles[0], "result artifact child 0 must carry a session file");
        assert.ok(resultSessionFiles[1], "result artifact child 1 must carry a session file");
        assert.notEqual(
          resultSessionFiles[0],
          resultSessionFiles[1],
          "result artifact per-child session files must be distinct",
        );

        // Cross-check: result session files match status session files.
        assert.equal(resultSessionFiles[0], stepSessionFiles?.[0]);
        assert.equal(resultSessionFiles[1], stepSessionFiles?.[1]);
      } finally {
        if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
        else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
      }
    },
  );

  it(
    "result-only revival reads session + paused state from result artifact when status dir is absent (F3)",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      // Opt in to the mock's --session-dir file creation so each paused child has a
      // discoverable session file that reaches the result artifact for revival.
      const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
      process.env.MOCK_PI_SESSION_DIR_FILE = "1";
      try {
        mockPi.onCall({ delay: 5_000, output: "revival alpha done" });
        mockPi.onCall({ delay: 5_000, output: "revival beta done" });
        const sessionRoot = path.join(tempDir, "sessions-f3");
        fs.mkdirSync(sessionRoot, { recursive: true });
        const id = `async-result-only-revival-${Date.now().toString(36)}`;
        executeAsyncParallel(id, {
          tasks: [
            {
              agent: "alpha",
              task: "Wait",
              acceptance: { level: "checked", criteria: ["Complete alpha"] },
            },
            {
              agent: "beta",
              task: "Wait",
              acceptance: { level: "checked", criteria: ["Complete beta"] },
            },
          ],
          concurrency: 2,
          agents: [makeAgent("alpha"), makeAgent("beta")],
          ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-f3" },
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
          sessionRoot,
        });

        await waitForMockPiCall(mockPi, 1);
        const runAsyncDir = path.join(ASYNC_DIR, id);
        const statusPath = path.join(runAsyncDir, "status.json");
        const statusBeforeInterrupt = JSON.parse(
          fs.readFileSync(statusPath, "utf-8"),
        ) as AsyncStatusPayload & {
          pid?: number;
        };
        deliverInterruptRequest({
          asyncDir: runAsyncDir,
          pid: statusBeforeInterrupt.pid,
          source: "test",
        });

        // Wait for the result artifact (state: "complete" is the persisted string).
        // 30s base: spawns 2 parallel children; extra headroom for slow runners.
        const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(30_000));
        const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
        assert.equal(payload.state, "paused");

        // Simulate result-only revival: rename the async status directory so
        // resolveAsyncResumeTarget falls through to the result artifact.
        const renamedDir = `${runAsyncDir}-renamed-for-f3-test`;
        fs.renameSync(runAsyncDir, renamedDir);
        try {
          const resumeTarget = resolveAsyncResumeTarget(
            { id, index: 0 },
            { asyncDirRoot: ASYNC_DIR, resultsDir: RESULTS_DIR },
          );
          assert.equal(resumeTarget.kind, "revive");
          assert.equal(resumeTarget.state, "paused");
          // F3(a): session context is present from the result artifact.
          assert.ok(resumeTarget.sessionFile, "session file must be present from result artifact");
          // F3(b): paused child correctly identified via interrupted flag.
          // F3(c): continuationAcceptance applied with monotonic-merge contract.
          assert.ok(
            resumeTarget.continuationAcceptance,
            "continuationAcceptance must be present from result artifact",
          );
          assert.equal(resumeTarget.continuationAcceptance.level, "checked");
        } finally {
          // Restore the async dir so afterEach cleanup does not leave orphans.
          try {
            fs.renameSync(renamedDir, runAsyncDir);
          } catch {
            /* best effort */
          }
        }
      } finally {
        if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
        else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
      }
    },
  );

  it(
    "enforces mixed async child ceilings independently",
    {
      skip:
        process.platform === "win32"
          ? "timeout signal delivery intermittent on Windows CI"
          : undefined,
    },
    async () => {
      mockPi.onCall({ matchArgIncludes: "Short async ceiling", delay: 5_000 });
      mockPi.onCall({ matchArgIncludes: "Long async ceiling", output: "long ceiling completed" });
      const id = `async-mixed-ceilings-${Date.now().toString(36)}`;
      executeAsyncParallel(id, {
        tasks: [
          { agent: "short", task: "Short async ceiling" },
          { agent: "long", task: "Long async ceiling" },
        ],
        concurrency: 2,
        agents: [
          makeAgent("short", { maxExecutionTimeMs: 100 }),
          makeAgent("long", { maxExecutionTimeMs: 2_147_483_648 }),
        ],
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactsDir: path.join(tempDir, "artifacts-mixed-ceilings"),
        artifactConfig: {
          enabled: true,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: true,
          cleanupDays: 7,
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });

      const payload = await readAsyncPayload(id);
      const status = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(payload.results[0]?.timedOut, true);
      assert.equal(payload.results[0]?.error, "Subagent timed out after 100ms.");
      assert.equal(payload.results[1]?.timedOut, undefined);
      assert.equal(payload.results[1]?.output, "long ceiling completed");
      assert.equal(status.steps?.[0]?.timeoutMs, 100);
      assert.equal(status.steps?.[1]?.timeoutMs, 2_147_483_648);
      assert.ok((status.steps?.[0]?.activeRuntimeMs ?? 0) >= 100);
      assert.ok((status.steps?.[1]?.activeRuntimeMs ?? 0) > 0);
      const firstStartedAt = status.steps?.[0]?.startedAt;
      const secondStartedAt = status.steps?.[1]?.startedAt;
      assert.ok(firstStartedAt !== undefined);
      assert.ok(secondStartedAt !== undefined);
      assert.equal(status.steps?.[0]?.deadlineAt, firstStartedAt + 100);
      assert.equal(status.steps?.[1]?.deadlineAt, secondStartedAt + 2_147_483_648);
      for (const [index, result] of payload.results.entries()) {
        assert.ok(result.artifactPaths?.metadataPath);
        const metadata = JSON.parse(
          fs.readFileSync(result.artifactPaths.metadataPath, "utf-8"),
        ) as {
          timeoutMs?: number;
          deadlineAt?: number;
        };
        assert.equal(metadata.timeoutMs, status.steps?.[index]?.timeoutMs);
        assert.equal(metadata.deadlineAt, status.steps?.[index]?.deadlineAt);
      }
    },
  );

  it("accumulates active runtime across async fallback attempts", async () => {
    const firstAttemptDelayMs = 500;
    mockPi.onCall({
      matchArgIncludes: "openai/gpt-5-mini",
      delay: firstAttemptDelayMs,
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "temporary provider failure" }],
            model: "openai/gpt-5-mini",
            errorMessage: "rate limit exceeded",
            stopReason: "error",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 1,
    });
    mockPi.onCall({
      matchArgIncludes: "anthropic/claude-sonnet-4",
      output: "Recovered on fallback",
    });
    const id = `async-fallback-runtime-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Retry this task after a temporary provider failure.",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4"],
        maxExecutionTimeMs: 5_000,
      }),
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

    const payload = await readAsyncPayload(id);
    const result = payload.results[0];
    assert.equal(payload.state, "complete");
    assert.equal(result?.model, "anthropic/claude-sonnet-4");
    assert.equal(result?.modelAttempts?.length, 2);
    assert.equal(result?.modelAttempts?.[0]?.success, false);
    assert.equal(result?.modelAttempts?.[1]?.success, true);
    // A fallback must retain the first failed attempt's active segment rather
    // than charging only the successful retry.
    assert.ok(
      (result?.activeRuntimeMs ?? 0) >= firstAttemptDelayMs - 50,
      `expected fallback runtime to include the failed attempt, got ${result?.activeRuntimeMs}ms`,
    );
    assert.equal(mockPi.callCount(), 2);
  });

  it(
    "freezes async step runtime before timeout cleanup",
    {
      skip:
        process.platform === "win32"
          ? "timeout signal delivery intermittent on Windows CI"
          : undefined,
    },
    async () => {
      // The mock ignores the graceful timeout signal, so the runner must wait
      // for hard cleanup. Logical runtime must stop at the step deadline rather
      // than charging that cleanup grace period.
      mockPi.onCall({ delay: 10_000, ignoreSigterm: true, output: "too late" });
      const id = `async-step-timeout-runtime-${Date.now().toString(36)}`;
      executeAsyncParallel(id, {
        tasks: [{ agent: "worker", task: "Run until the step ceiling." }],
        agents: [makeAgent("worker", { maxExecutionTimeMs: 100 })],
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
      await waitForMockPiCall(mockPi, 0);

      const payload = await readAsyncPayload(id);
      const runtimeMs = payload.results[0]?.activeRuntimeMs ?? 0;
      assert.equal(payload.state, "failed");
      assert.equal(payload.results[0]?.timedOut, true);
      assert.ok(
        runtimeMs < 2_000,
        `timeout cleanup must not consume logical runtime; observed ${runtimeMs}ms`,
      );
    },
  );

  it(
    "marks async parallel runs that exceed the shared run deadline as timed out",
    {
      skip:
        process.platform === "win32"
          ? "timeout signal delivery intermittent on Windows CI"
          : undefined,
    },
    async () => {
      // Invariant: the shared run deadline must stay strictly below childDelayMs
      // (the run times out before children finish), and both must scale together
      // under TLH_TEST_TIMEOUT_SCALE so the ~30% ratio is preserved on loaded CI
      // runners. This guarantees both children are spawned and recorded before the
      // deadline fires, while still ensuring the run exceeds its own deadline.
      const childDelayMs = scaleTestTimeout(5_000);
      const timeoutMs = scaleTestTimeout(1_500); // ≈30% of childDelayMs at all scales
      mockPi.onCall({ delay: childDelayMs, output: "one done" });
      mockPi.onCall({ delay: childDelayMs, output: "two done" });
      const id = `async-timeout-parallel-${Date.now().toString(36)}`;
      const launch = executeAsyncParallel(id, {
        tasks: [
          { agent: "one", task: "Wait" },
          { agent: "two", task: "Wait" },
        ],
        concurrency: 2,
        agents: [makeAgent("one"), makeAgent("two")],
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
        // This is the internal run-deadline seam; public callers configure it
        // through execution.maxRunTimeMs at the executor boundary.
        timeoutMs,
      });
      assert.equal(launch.isError, undefined);
      assert.equal(launch.details.timeoutMs, timeoutMs);
      assert.ok(launch.details.deadlineAt !== undefined);

      await waitForMockPiCall(mockPi, 1);
      const resultPath = await waitForAsyncResultFile(id);
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const status = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(payload.state, "failed");
      assert.equal(payload.success, false);
      assert.equal(payload.exitCode, 1);
      const sharedDeadlineMessage = "Subagent exceeded the configured maximum execution time.";
      // The resolved run timeout is represented by an absolute deadline in the
      // executable runner config; the retired root timeoutMs field is not copied
      // into the new durable status/result artifacts.
      assert.equal(payload.timeoutMs, undefined);
      assert.equal(payload.deadlineAt, launch.details.deadlineAt);
      assert.equal(payload.timedOut, true);
      assert.ok((payload.summary ?? "").includes(sharedDeadlineMessage));
      assert.equal(status.state, "failed");
      assert.equal(status.timeoutMs, undefined);
      assert.equal(status.deadlineAt, launch.details.deadlineAt);
      assert.equal(status.timedOut, true);
      assert.ok((status.error ?? "").includes(sharedDeadlineMessage));
      assert.deepEqual(
        status.steps?.map((step) => step.status),
        ["failed", "failed"],
      );
      assert.deepEqual(
        status.steps?.map((step) => step.timedOut),
        [true, true],
      );
      assert.deepEqual(
        status.steps?.map((step) => step.error),
        [sharedDeadlineMessage, sharedDeadlineMessage],
      );
      assert.deepEqual(
        payload.results.map((result) => result.timedOut),
        [true, true],
      );
      assert.deepEqual(
        payload.results.map((result) => result.terminationReason),
        ["timed_out", "timed_out"],
      );
      assert.deepEqual(
        status.steps?.map((step) => step.terminationReason),
        ["timed_out", "timed_out"],
      );
      assert.equal(mockPi.callCount(), 2);
    },
  );

  it(
    "preserves termination reasons for direct parallel result children",
    {
      skip:
        process.platform === "win32"
          ? "control and timeout delivery are intermittent on Windows CI"
          : undefined,
    },
    async () => {
      const launch = (
        id: string,
        tasks: Array<{ agent: string; task: string }>,
        options: { timeoutMs?: number } = {},
      ) =>
        executeAsyncParallel(id, {
          tasks,
          concurrency: 1,
          agents: tasks.map(({ agent }) => makeAgent(agent)),
          ctx: {
            pi: { events: { emit() {} } },
            cwd: tempDir,
            currentSessionId: "session-synthesized",
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
          ...options,
        });

      const childDelayMs = scaleTestTimeout(5_000);
      mockPi.onCall({
        matchArgIncludes: "Pause first",
        delay: childDelayMs,
        output: "paused child",
      });
      const pausedId = `async-synthesized-paused-${Date.now().toString(36)}`;
      launch(pausedId, [
        { agent: "paused-one", task: "Pause first" },
        { agent: "paused-two", task: "Pause second" },
      ]);
      await waitForMockPiCall(mockPi, 0, scaleTestTimeout(10_000));
      const pausedDir = path.join(ASYNC_DIR, pausedId);
      const pausedStatus = JSON.parse(
        fs.readFileSync(path.join(pausedDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload & {
        pid?: number;
      };
      deliverInterruptRequest({ asyncDir: pausedDir, pid: pausedStatus.pid, source: "test" });
      const pausedPayload = JSON.parse(
        fs.readFileSync(await waitForAsyncResultFile(pausedId, scaleTestTimeout(30_000)), "utf-8"),
      ) as AsyncResultPayload;
      assert.deepEqual(
        pausedPayload.results.map((result) => result.terminationReason),
        ["paused", "paused"],
      );

      // The interrupted child can leave a response queued while its sibling is
      // synthesized. Start the next phase from a fresh mock generation so a
      // later phase cannot consume that stale response.
      mockPi.reset();
      mockPi.onCall({
        matchArgIncludes: "Timeout first",
        delay: childDelayMs,
        output: "timed out child",
      });
      const timedOutId = `async-synthesized-timeout-${Date.now().toString(36)}`;
      const timedOutMs = scaleTestTimeout(500);
      launch(
        timedOutId,
        [
          { agent: "timeout-one", task: "Timeout first" },
          { agent: "timeout-two", task: "Timeout second" },
        ],
        { timeoutMs: timedOutMs },
      );
      const timedOutPayload = JSON.parse(
        fs.readFileSync(
          await waitForAsyncResultFile(timedOutId, scaleTestTimeout(10_000)),
          "utf-8",
        ),
      ) as AsyncResultPayload;
      assert.equal(timedOutPayload.state, "failed");
      assert.equal(timedOutPayload.timedOut, true);
      assert.deepEqual(
        timedOutPayload.results.map((result) => result.terminationReason),
        ["timed_out", "timed_out"],
      );
      assert.deepEqual(
        timedOutPayload.results.map((result) => result.timedOut),
        [true, true],
      );
    },
  );

  it("cancels async acceptance verification when the run times out", async () => {
    mockPi.onCall({ output: "implementation complete" });
    const id = `async-timeout-acceptance-${Date.now().toString(36)}`;
    const timeoutMs = 1_000;
    // Both the verify sleep and the verify command timeout are scaled so that
    // the ratio invariant holds at any TLH_TEST_TIMEOUT_SCALE factor:
    //   verifySleepMs (scale*30_000) >> timeoutMs (1_000) + scaleTestTimeout(4_000) (scale*4_000)
    //   i.e. scale*30_000 > 1_000 + scale*4_000  ⟺  scale*26_000 > 1_000, true for all scale > 0.
    // Without scaling both sides, a sufficiently large scale factor would let the
    // bound exceed the sleep, making a non-cancelling runner appear to pass.
    const verifySleepMs = scaleTestTimeout(30_000);
    const verifyTimeoutMs = scaleTestTimeout(60_000);
    const startedAt = Date.now();
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Implement with verified acceptance",
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
      timeoutMs,
      acceptance: {
        level: "verified",
        verify: [
          {
            id: "slow",
            command: `${process.execPath} -e "setTimeout(()=>process.exit(0), ${verifySleepMs})"`,
            timeoutMs: verifyTimeoutMs,
          },
        ],
      },
    });

    const resultPath = await waitForAsyncResultFile(id);
    const elapsedMs = Date.now() - startedAt;
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(payload.state, "failed");
    assert.equal(payload.timedOut, true);
    assert.equal(payload.results[0]?.timedOut, true);
    assert.equal(payload.results[0]?.acceptance, undefined);
    assert.equal(status.steps?.[0]?.timedOut, true);
    assert.ok(
      // The 4_000ms slack is load-sensitive: on a slow CI machine shutdown
      // overhead after the timeout fires can exceed a fixed constant.
      // Scale it so the bound absorbs machine slowness. verifySleepMs
      // is also scaled (see above) so the ratio invariant is maintained.
      elapsedMs < timeoutMs + scaleTestTimeout(4_000),
      `timeout should cancel acceptance verification well before the verify command completes, elapsed ${elapsedMs}ms`,
    );
  });

  it(
    "interrupts async acceptance verification and returns a paused result",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      mockPi.onCall({ output: "implementation complete" });
      const id = `async-interrupt-acceptance-${Date.now().toString(36)}`;
      // Ratio invariant: verifySleepMs sets a floor that proves interrupt aborted
      // verification rather than waiting for it to complete. promptnessMs must
      // remain strictly below verifySleepMs on every machine, and both must scale
      // together so the invariant is preserved under TLH_TEST_TIMEOUT_SCALE.
      // verifyTimeoutMs must remain safely above verifySleepMs so the step cannot
      // time out on its own before the interrupt lands.
      const verifySleepMs = scaleTestTimeout(5_000);
      const promptnessMs = scaleTestTimeout(3_000);
      const verifyTimeoutMs = verifySleepMs * 2;
      const startedAt = Date.now();
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Implement with verified acceptance",
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
        acceptance: {
          level: "verified",
          verify: [
            {
              id: "slow",
              command: `${process.execPath} -e "setTimeout(()=>process.exit(0), ${verifySleepMs})"`,
              timeoutMs: verifyTimeoutMs,
            },
          ],
        },
      });

      const asyncDir = path.join(ASYNC_DIR, id);
      const statusPath = path.join(asyncDir, "status.json");
      await waitForMockPiCall(mockPi, 0);
      await waitForAsyncState(asyncDir, "running");
      const statusBeforeInterrupt = JSON.parse(
        fs.readFileSync(statusPath, "utf-8"),
      ) as AsyncStatusPayload & {
        pid?: number;
      };
      deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

      const resultPath = await waitForAsyncResultFile(id);
      await waitForAsyncState(asyncDir, "paused");
      const elapsedMs = Date.now() - startedAt;
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
      assert.equal(payload.state, "paused");
      assert.equal(payload.exitCode, 0);
      assert.equal(payload.results[0]?.error, undefined);
      assert.equal(payload.results[0]?.acceptance?.status, "skipped");
      assert.equal(status.steps?.[0]?.status, "paused");
      assert.equal(status.steps?.[0]?.acceptance?.status, "skipped");
      assert.ok(
        elapsedMs < promptnessMs,
        `interrupt should abort async verification promptly, elapsed ${elapsedMs}ms (bound=${promptnessMs}ms, verifySleep=${verifySleepMs}ms)`,
      );
    },
  );

  it("background forced drain after final assistant output is cleanup success", async () => {
    // Ratio invariant: keepaliveMs sets the mock's natural exit boundary.
    // elapsed < drainBoundMs proves the runner cleaned up the child proactively
    // rather than waiting for the keepalive to expire. Both must scale together
    // so the invariant is preserved under TLH_TEST_TIMEOUT_SCALE.
    const keepaliveMs = scaleTestTimeout(10_000);
    const drainBoundMs = scaleTestTimeout(9_000);
    mockPi.onCall({
      jsonl: [events.assistantMessage("async-done-before-drain")],
      stderr: "Done after 1 turn(s). Ready for input.\n",
      keepAliveAfterFinalMessageMs: keepaliveMs,
    });

    const id = `async-final-drain-${Date.now().toString(36)}`;
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const sessionRoot = path.join(tempDir, "sessions");

    const start = Date.now();
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
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
      sessionRoot,
      maxSubagentDepth: 2,
    });

    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline) {
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const elapsed = Date.now() - start;
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.ok(
      elapsed < drainBoundMs,
      `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms (bound=${drainBoundMs}ms, keepalive=${keepaliveMs}ms)`,
    );
    assert.equal(payload.success, true);
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.results[0].success, true);
    assert.equal(payload.results[0].output, "async-done-before-drain");
  });

  it("background forced drain after empty terminal assistant output is cleanup success", async () => {
    // Ratio invariant: keepaliveMsEmpty sets the mock's natural exit boundary.
    // elapsed < drainBoundMsEmpty proves the runner cleaned up the child proactively
    // rather than waiting for the keepalive to expire. Both must scale together
    // so the invariant is preserved under TLH_TEST_TIMEOUT_SCALE.
    const keepaliveMsEmpty = scaleTestTimeout(10_000);
    const drainBoundMsEmpty = scaleTestTimeout(9_000);
    mockPi.onCall({
      jsonl: [events.assistantMessage("")],
      keepAliveAfterFinalMessageMs: keepaliveMsEmpty,
    });

    const id = `async-final-drain-empty-${Date.now().toString(36)}`;
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);

    const start = Date.now();
    executeAsyncSingle(id, {
      agent: "scout",
      task: "Inspect something",
      agentConfig: makeAgent("scout"),
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

    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline)
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const elapsed = Date.now() - start;
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.ok(
      elapsed < drainBoundMsEmpty,
      `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms (bound=${drainBoundMsEmpty}ms, keepalive=${keepaliveMsEmpty}ms)`,
    );
    assert.equal(payload.success, true);
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.results[0].success, true);
    assert.equal(payload.results[0].output, "");
  });

  it("background final-drain cleanup preserves explicit assistant errors", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "failed" }],
            model: "mock/test-model",
            stopReason: "stop",
            errorMessage: "provider exploded",
            usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
          },
        },
      ],
      keepAliveAfterFinalMessageMs: 10000,
    });

    const id = `async-final-drain-error-${Date.now().toString(36)}`;
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);

    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
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

    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline)
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.equal(payload.success, false);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.results[0].success, false);
    assert.equal(payload.results[0].error, "provider exploded");
  });

  it(
    "background interrupted runs still clean up owned process groups",
    {
      skip:
        process.platform === "win32"
          ? "owned process-group cleanup unsupported on win32"
          : undefined,
    },
    async () => {
      mockPi.onCall({ delay: 10_000 });

      const id = `async-interrupt-cleanup-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, id);
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Do work",
        agentConfig: makeAgent("worker"),
        acceptance: { level: "checked", criteria: ["Complete the work"] },
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

      await waitForMockPiCall(mockPi, 0);
      await waitForAsyncState(asyncDir, "running");
      requestAsyncInterrupt(asyncDir, { source: "async-execution-test" });

      const resultPath = await waitForAsyncResultFile(id);
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const status = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const processCleanup = payload.results[0]?.processCleanup;
      assert.equal(payload.success, false);
      assert.equal(payload.state, "paused");
      assert.equal(payload.exitCode, 0);
      assert.equal(payload.results[0]?.acceptance?.status, "skipped");
      assert.equal(status.steps?.[0]?.status, "paused");
      assert.equal(status.steps?.[0]?.acceptance?.status, "skipped");
      assert.equal(payload.summary, "Paused after interrupt. Waiting for explicit next action.");
      assert.ok(processCleanup, "expected background result to report process cleanup");
      assert.equal(processCleanup?.attempted, true);
      assert.equal(processCleanup?.terminated, true);
      assert.equal(processCleanup?.skippedReason, undefined);
      assert.equal(typeof processCleanup?.processGroupId, "number");
    },
  );

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
