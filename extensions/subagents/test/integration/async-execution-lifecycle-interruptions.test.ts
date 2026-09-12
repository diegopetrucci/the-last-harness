/**
 * Integration tests for async execution – interruption, deadlines, and cleanup.
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
import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  RESULTS_DIR,
  executeAsyncParallel,
  executeAsyncSingle,
  readAsyncPayload,
  requestAsyncInterrupt,
  waitForAsyncResultFile,
  waitForAsyncState,
  waitForMockPiCall,
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
      // stepCeilingMs must scale with TLH_TEST_TIMEOUT_SCALE so that the child
      // process is reliably spawned and recorded before the deadline fires on
      // loaded CI runners (where TLH_TEST_TIMEOUT_SCALE=3). The mock delay
      // stays well above stepCeilingMs at every scale so the child is still
      // alive when the step deadline fires and ignoreSigterm exercises the
      // hard-kill path. The bound below is relative to the ceiling:
      //   pass case:  runtimeMs ≈ stepCeilingMs  (logical clock frozen at deadline)
      //   fail case:  runtimeMs ≈ stepCeilingMs + CHILD_PROTOCOL_HARD_KILL_GRACE_MS (3000)
      // A margin of 1500 ms sits clearly between 0 and 3000 at both scale 1 and scale 3.
      const stepCeilingMs = scaleTestTimeout(1_000);
      mockPi.onCall({ delay: scaleTestTimeout(10_000), ignoreSigterm: true, output: "too late" });
      const id = `async-step-timeout-runtime-${Date.now().toString(36)}`;
      executeAsyncParallel(id, {
        tasks: [{ agent: "worker", task: "Run until the step ceiling." }],
        agents: [makeAgent("worker", { maxExecutionTimeMs: stepCeilingMs })],
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
        runtimeMs < stepCeilingMs + 1_500,
        `timeout cleanup must not consume logical runtime; expected < ${stepCeilingMs + 1_500}ms (ceiling ${stepCeilingMs}ms + 1500ms margin), observed ${runtimeMs}ms`,
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
});
