/**
 * Integration tests for async execution – interruption, deadlines, and cleanup.
 *
 * Requires pi packages to be importable.
 */

import { spawn } from "node:child_process";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
  waitForAsyncStatusPredicate,
  waitForMarker,
  waitForMockPiCall,
} from "../support/async-execution-helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

const MOCK_PI_SCRIPT_PATH = fileURLToPath(
  new URL("../support/mock-pi-script.mjs", import.meta.url),
);

// Freeze publication at the final boundary. The old direct-write implementation
// exposes a partial final file; the atomic implementation leaves only its
// complete, non-discoverable temporary file visible until rename.
const HOLD_PUBLICATION_PRELOAD = `
const fs = require("node:fs");
const path = require("node:path");

const originalWriteFileSync = fs.writeFileSync;
const originalRenameSync = fs.renameSync;
let held = false;

function isCallRecord(filePath) {
  const name = path.basename(String(filePath));
  return (
    (name.startsWith("call-") || name.startsWith("stale-call-")) &&
    name.endsWith(".json")
  );
}

function holdPublication() {
  if (held) return;
  held = true;
  originalWriteFileSync(process.env.MOCK_PI_PUBLICATION_READY, "", "utf8");
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(process.env.MOCK_PI_PUBLICATION_RELEASE)) {
    if (Date.now() >= deadline) {
      process.stderr.write(
        "mock-pi publication preload: timed out waiting for release marker: " +
          process.env.MOCK_PI_PUBLICATION_RELEASE +
          "\\n",
      );
      process.exit(1);
    }
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
}

fs.writeFileSync = (filePath, data, options) => {
  if (!isCallRecord(filePath)) return originalWriteFileSync(filePath, data, options);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  originalWriteFileSync(
    filePath,
    bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
    options,
  );
  holdPublication();
  return originalWriteFileSync(filePath, data, options);
};

fs.renameSync = (sourcePath, targetPath) => {
  if (isCallRecord(targetPath)) holdPublication();
  return originalRenameSync(sourcePath, targetPath);
};
`;

function sanitizedChildEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "TICKETS_DIR" || key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_"))
      delete env[key];
  }
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...overrides };
}

function spawnMockPiScript(
  preloadPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--require", preloadPath, MOCK_PI_SCRIPT_PATH, ...args],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `mock-pi publication child exited with ${signal ? `signal ${signal}` : `status ${code}`}: ${stderr.trim()}`,
        ),
      );
    });
  });
}

function isPublishedCallName(name: string): boolean {
  return (name.startsWith("call-") || name.startsWith("stale-call-")) && name.endsWith(".json");
}

describe("async execution lifecycle interruptions", () => {
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

  it("publishes complete mock call records atomically for normal and stale invocations", async () => {
    const preloadPath = path.join(tempDir, "hold-publication.cjs");
    fs.writeFileSync(preloadPath, HOLD_PUBLICATION_PRELOAD, "utf8");

    const runCase = async (stale: boolean): Promise<void> => {
      mockPi.reset();
      const label = stale ? "stale" : "normal";
      const readyPath = path.join(tempDir, `${label}-publication-ready`);
      const releasePath = path.join(tempDir, `${label}-publication-release`);
      const currentGeneration = fs
        .readFileSync(path.join(mockPi.dir, "current-generation.txt"), "utf8")
        .trim();
      const args = ["--mode", "json", "--model", `mock/${label}`];
      const childDone = spawnMockPiScript(
        preloadPath,
        args,
        sanitizedChildEnv({
          MOCK_PI_QUEUE_DIR: mockPi.dir,
          MOCK_PI_GENERATION: stale ? `${currentGeneration}-stale` : currentGeneration,
          MOCK_PI_PUBLICATION_READY: readyPath,
          MOCK_PI_PUBLICATION_RELEASE: releasePath,
        }),
      );

      try {
        await Promise.race([
          waitForMarker(readyPath, scaleTestTimeout(5_000)),
          childDone.then(
            () => assert.fail("mock-pi exited before publication was held"),
            (error: unknown) => {
              throw error;
            },
          ),
        ]);

        const heldNames = fs.readdirSync(mockPi.dir);
        assert.equal(
          heldNames.some(isPublishedCallName),
          false,
          "readers must not discover a call record while publication is held",
        );
        assert.equal(
          mockPi.callCount(),
          0,
          "callCount must not see the publication temporary file by its prefix",
        );
        assert.ok(
          heldNames.some((name) => name.startsWith(".tmp-")),
          "publication must have a same-directory temporary file while held",
        );

        fs.writeFileSync(releasePath, "", "utf8");
        await childDone;

        const completedNames = fs.readdirSync(mockPi.dir);
        assert.equal(
          completedNames.some((name) => name.startsWith(".tmp-")),
          false,
          "publication temporary files must be renamed away after completion",
        );
        const completedCallNames = completedNames.filter(isPublishedCallName);
        assert.equal(completedCallNames.length, 1);
        assert.equal(completedCallNames[0]?.startsWith(stale ? "stale-call-" : "call-"), true);

        if (stale) {
          const payload = JSON.parse(
            fs.readFileSync(path.join(mockPi.dir, completedCallNames[0]!), "utf8"),
          ) as { args?: string[] };
          assert.deepEqual(payload.args, args);
          assert.equal(mockPi.callCount(), 0, "stale records must remain outside callCount");
        } else {
          assert.deepEqual((await waitForMockPiCall(mockPi, 0)).args, args);
          assert.equal(mockPi.callCount(), 1);
        }
      } finally {
        fs.writeFileSync(releasePath, "", "utf8");
        await childDone.catch(() => undefined);
      }
    };

    await runCase(false);
    await runCase(true);
  });

  it(
    "attributes a role timeout when call publication is held before the record exists",
    {
      skip:
        process.platform === "win32"
          ? "timeout signal delivery intermittent on Windows CI"
          : undefined,
    },
    async () => {
      const preloadPath = path.join(tempDir, "hold-role-timeout-publication.cjs");
      const readyPath = path.join(tempDir, "role-timeout-publication-ready");
      const releasePath = path.join(tempDir, "role-timeout-publication-release");
      fs.writeFileSync(preloadPath, HOLD_PUBLICATION_PRELOAD, "utf8");
      const previousNodeOptions = process.env.NODE_OPTIONS;
      const previousReadyPath = process.env.MOCK_PI_PUBLICATION_READY;
      const previousReleasePath = process.env.MOCK_PI_PUBLICATION_RELEASE;
      // Product deadline the test waits to fire: unscaled. The test tolerates the
      // deadline firing before the mock child publishes (see below) and asserts
      // only the terminal result, so a slow runner cannot invalidate it.
      const roleTimeoutMs = 2_000;
      const id = `async-role-timeout-before-call-record-${Date.now().toString(36)}`;
      mockPi.onCall({ delay: 60_000, output: "too late" });
      process.env.NODE_OPTIONS = [previousNodeOptions, `--require=${preloadPath}`]
        .filter(Boolean)
        .join(" ");
      process.env.MOCK_PI_PUBLICATION_READY = readyPath;
      process.env.MOCK_PI_PUBLICATION_RELEASE = releasePath;

      try {
        executeAsyncSingle(id, {
          agent: "role-bound",
          task: "Wait for the role ceiling before call publication completes.",
          agentConfig: makeAgent("role-bound", { maxExecutionTimeMs: roleTimeoutMs }),
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

        // Startup may expire before the preload reaches readyPath; the terminal
        // result is the boundary for asserting timeout attribution and no call.
        const payload = await readAsyncPayload(id);
        assert.equal(payload.state, "failed");
        assert.equal(payload.timedOut, true);
        assert.equal(payload.results[0]?.timedOut, true);
        assert.equal(payload.results[0]?.timeoutOwner, "role");
        assert.equal(payload.results[0]?.error, `Subagent timed out after ${roleTimeoutMs}ms.`);
        assert.equal(mockPi.callCount(), 0, "timeout attribution must not require a call record");
      } finally {
        try {
          await mockPi.cleanup();
        } finally {
          try {
            fs.writeFileSync(releasePath, "", "utf8");
          } finally {
            if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
            else process.env.NODE_OPTIONS = previousNodeOptions;
            if (previousReadyPath === undefined) delete process.env.MOCK_PI_PUBLICATION_READY;
            else process.env.MOCK_PI_PUBLICATION_READY = previousReadyPath;
            if (previousReleasePath === undefined) delete process.env.MOCK_PI_PUBLICATION_RELEASE;
            else process.env.MOCK_PI_PUBLICATION_RELEASE = previousReleasePath;
          }
        }
      }
    },
  );

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
          },
          {
            agent: "two",
            task: "Wait",
          },
          {
            agent: "three",
            task: "Wait",
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
            },
            {
              agent: "beta",
              task: "Wait",
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

        // Both children must be paused.
        assert.deepEqual(
          status.steps?.map((s) => s.status),
          ["paused", "paused"],
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
            },
            {
              agent: "beta",
              task: "Wait",
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

        // Wait for the result artifact (state: "paused" is the persisted string).
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
        controlConfig: {
          enabled: true,
          needsAttentionAfterMs: 2_000,
          failedToolAttemptsBeforeAttention: 3,
          notifyOn: ["needs_attention"],
          notifyChannels: ["event", "async"],
        },
        telemetryProvenance: {
          tlhVersion: "test-tlh",
          piVersion: "test-pi",
          installGeneration: "test-generation",
          loadedAt: 123,
        },
      });

      const payload = await readAsyncPayload(id);
      const status = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(payload.timedOut, true);
      assert.equal(status.timedOut, true);
      assert.equal(payload.telemetry?.outcome?.state, "failed");
      assert.equal(payload.telemetry?.outcome?.terminationReason, "timed_out");
      assert.equal(status.telemetry?.outcome?.terminationReason, "timed_out");
      assert.equal(payload.telemetry?.steps[0]?.outcome?.terminationReason, "timed_out");
      assert.equal(payload.results[0]?.timedOut, true);
      assert.equal(payload.results[0]?.error, "Subagent timed out after 100ms.");
      assert.equal(payload.results[1]?.timedOut, undefined);
      assert.equal(payload.results[1]?.output, "long ceiling completed");
      assert.equal(status.steps?.[0]?.timeoutMs, 100);
      assert.equal(status.steps?.[1]?.timeoutMs, 2_147_483_648);
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

  it(
    "allows a later parallel interrupt after a step-owned timeout",
    {
      skip:
        process.platform === "win32"
          ? "timeout and interrupt delivery are intermittent on Windows CI"
          : undefined,
    },
    async () => {
      const shortTimeoutMs = scaleTestTimeout(1_000);
      const shortTimeoutHold = path.join(tempDir, "short-timeout-hold");
      const interruptSiblingHold = path.join(tempDir, "interrupt-sibling-hold");
      mockPi.onCall({
        matchArgIncludes: "Short timeout sibling",
        waitForMarker: shortTimeoutHold,
        ignoreSigterm: true,
      });
      mockPi.onCall({
        matchArgIncludes: "Long interrupt sibling",
        waitForMarker: interruptSiblingHold,
      });
      const id = `async-step-timeout-then-interrupt-${Date.now().toString(36)}`;
      executeAsyncParallel(id, {
        tasks: [
          { agent: "short", task: "Short timeout sibling" },
          { agent: "long", task: "Long interrupt sibling" },
        ],
        concurrency: 2,
        agents: [
          makeAgent("short", { maxExecutionTimeMs: shortTimeoutMs }),
          makeAgent("long", { maxExecutionTimeMs: 2_147_483_648 }),
        ],
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
        controlConfig: {
          enabled: true,
          needsAttentionAfterMs: 2_000,
          failedToolAttemptsBeforeAttention: 3,
          notifyOn: ["needs_attention"],
          notifyChannels: ["event", "async"],
        },
        telemetryProvenance: {
          tlhVersion: "test-tlh",
          piVersion: "test-pi",
          installGeneration: "test-generation",
          loadedAt: 123,
        },
      });

      await waitForMockPiCall(mockPi, 0);
      await waitForMockPiCall(mockPi, 1);
      const asyncDir = path.join(ASYNC_DIR, id);
      const timedOutStatus = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) => status.state === "running" && status.steps?.[0]?.timedOut === true,
        "step-owned timeout before sibling interrupt",
      );
      assert.equal(timedOutStatus.timedOut, undefined);
      assert.ok(timedOutStatus.pid);
      deliverInterruptRequest({ asyncDir, pid: timedOutStatus.pid, source: "test" });

      const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(30_000));
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const status = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const eventLog = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
      assert.equal(payload.state, "paused");
      assert.equal(payload.timedOut, undefined);
      assert.equal(status.timedOut, undefined);
      assert.equal(payload.telemetry?.outcome?.state, "paused");
      assert.equal(payload.telemetry?.outcome?.terminationReason, "interrupted");
      assert.equal(payload.telemetry?.steps[0]?.outcome?.terminationReason, "timed_out");
      assert.deepEqual(
        payload.results.map((result) => result.timedOut),
        [true, undefined],
      );
      assert.deepEqual(
        payload.results.map((result) => result.terminationReason),
        ["timed_out", "paused"],
      );
      assert.equal(payload.results[0]?.interrupted, undefined);
      assert.equal(payload.results[0]?.pause, undefined);
      assert.deepEqual(
        status.steps?.map((step) => step.status),
        ["failed", "paused"],
      );
      assert.equal(status.steps?.[0]?.timedOut, true);
      assert.equal(status.steps?.[0]?.pause, undefined);
      assert.match(eventLog, /"type":"subagent.run.paused"/);
      assert.doesNotMatch(eventLog, /"type":"subagent.run.timed_out"/);
    },
  );

  it("keeps one per-instance role budget across a model fallback respawn", async () => {
    const roleTimeoutMs = scaleTestTimeout(2_000);
    const firstAttemptGate = path.join(tempDir, "first-attempt-release");
    const fallbackAttemptGate = path.join(tempDir, "fallback-attempt-release");
    mockPi.onCall({
      matchArgIncludes: "openai/gpt-5-mini",
      waitForMarker: firstAttemptGate,
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
      waitForMarker: fallbackAttemptGate,
      output: "Recovered on fallback",
    });
    const id = `async-fallback-fresh-deadline-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Retry this task after a temporary provider failure.",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4"],
        maxExecutionTimeMs: roleTimeoutMs,
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

    await waitForMockPiCall(mockPi, 0);
    const statusPath = path.join(ASYNC_DIR, id, "status.json");
    const firstStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
    const firstStep = firstStatus.steps?.[0];
    assert.ok(firstStep?.startedAt !== undefined);
    assert.equal(firstStep?.timeoutMs, roleTimeoutMs);
    // The deadline is the instance's remaining active budget anchored at launch,
    // so it can never exceed the role budget measured from the child spawn.
    assert.ok((firstStep?.deadlineAt ?? Infinity) <= (firstStep?.startedAt ?? 0) + roleTimeoutMs);
    const firstStartedAt = firstStep.startedAt;
    const firstDeadlineAt = firstStep.deadlineAt;
    assert.ok(firstDeadlineAt !== undefined);

    while (Date.now() <= firstStartedAt) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    fs.writeFileSync(firstAttemptGate, "", "utf-8");
    await waitForMockPiCall(mockPi, 1);
    const fallbackStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
    const fallbackStep = fallbackStatus.steps?.[0];
    assert.ok(fallbackStep?.startedAt !== undefined);
    assert.equal(fallbackStep?.timeoutMs, roleTimeoutMs);
    // A fallback respawn spends the same instance budget; it does not restart the clock.
    assert.ok(
      (fallbackStep?.deadlineAt ?? Infinity) <= (fallbackStep?.startedAt ?? 0) + roleTimeoutMs,
    );
    assert.ok(fallbackStep.startedAt > firstStartedAt);
    assert.ok((fallbackStep.deadlineAt ?? Infinity) <= firstDeadlineAt);

    fs.writeFileSync(fallbackAttemptGate, "", "utf-8");
    const payload = await readAsyncPayload(id);
    const result = payload.results[0];
    assert.equal(payload.state, "complete");
    assert.equal(result?.model, "anthropic/claude-sonnet-4");
    assert.equal(result?.modelAttempts?.length, 2);
    assert.equal(result?.modelAttempts?.[0]?.success, false);
    assert.equal(result?.modelAttempts?.[1]?.success, true);
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    const step = status.steps?.[0];
    assert.ok(step?.startedAt !== undefined);
    assert.equal(step?.timeoutMs, roleTimeoutMs);
    assert.ok((step?.deadlineAt ?? Infinity) <= (step?.startedAt ?? 0) + roleTimeoutMs);
    assert.ok((step?.activeRuntimeMs ?? 0) > 0, "consumed active runtime is persisted");
    assert.equal(mockPi.callCount(), 2);
  });

  it(
    "records the step deadline before timeout cleanup",
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
      // hard-kill path.
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
      assert.equal(payload.state, "failed");
      assert.equal(payload.results[0]?.timedOut, true);
      const status = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const step = status.steps?.[0];
      assert.ok(step?.startedAt !== undefined);
      assert.equal(step?.deadlineAt, (step?.startedAt ?? 0) + stepCeilingMs);
    },
  );

  it(
    "marks async parallel children that exceed their role deadlines as timed out",
    {
      skip:
        process.platform === "win32"
          ? "timeout signal delivery intermittent on Windows CI"
          : undefined,
    },
    async () => {
      // Each role deadline must stay strictly below childDelayMs (each child
      // times out before it finishes), and both must scale together under
      // TLH_TEST_TIMEOUT_SCALE so the ~30% ratio is preserved on loaded CI
      // runners. There is deliberately no shared batch deadline.
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
        agents: [
          makeAgent("one", { maxExecutionTimeMs: timeoutMs }),
          makeAgent("two", { maxExecutionTimeMs: timeoutMs }),
        ],
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
      assert.equal(launch.isError, undefined);
      assert.equal(launch.details.timeoutMs, undefined);
      assert.equal(launch.details.deadlineAt, undefined);

      await waitForMockPiCall(mockPi, 1);
      const resultPath = await waitForAsyncResultFile(id);
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const status = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(payload.state, "failed");
      assert.equal(payload.success, false);
      assert.equal(payload.exitCode, 1);
      const roleDeadlineMessage = `Subagent timed out after ${timeoutMs}ms.`;
      // Parallel batches have no shared root deadline. Each child owns its
      // independently derived role deadline and timer.
      assert.equal(payload.timeoutMs, undefined);
      assert.equal(payload.deadlineAt, undefined);
      assert.equal(payload.timedOut, true);
      assert.ok((payload.summary ?? "").includes(roleDeadlineMessage));
      assert.equal(status.state, "failed");
      assert.equal(status.timeoutMs, undefined);
      assert.equal(status.deadlineAt, undefined);
      assert.equal(status.timedOut, true);
      assert.ok((status.error ?? "").includes(roleDeadlineMessage));
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
        [roleDeadlineMessage, roleDeadlineMessage],
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
        options: { agentMaxExecutionTimeMs?: number } = {},
      ) =>
        executeAsyncParallel(id, {
          tasks,
          concurrency: 1,
          agents: tasks.map(({ agent }) =>
            makeAgent(agent, { maxExecutionTimeMs: options.agentMaxExecutionTimeMs }),
          ),
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
      // Product deadline the test waits to fire: unscaled. The test waits only for
      // the terminal result, which is valid whether or not the child spawned first.
      const timedOutMs = 500;
      launch(
        timedOutId,
        [
          { agent: "timeout-one", task: "Timeout first" },
          { agent: "timeout-two", task: "Timeout second" },
        ],
        { agentMaxExecutionTimeMs: timedOutMs },
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
        ["timed_out", "completed"],
      );
      assert.deepEqual(
        timedOutPayload.results.map((result) => result.timedOut),
        [true, undefined],
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

    await waitForAsyncResultFile(id, scaleTestTimeout(10_000));

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

    await waitForAsyncResultFile(id, scaleTestTimeout(10_000));

    const elapsed = Date.now() - start;
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.ok(
      elapsed < drainBoundMsEmpty,
      `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms (bound=${drainBoundMsEmpty}ms, keepalive=${keepaliveMsEmpty}ms)`,
    );
    assert.equal(payload.success, false);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.results[0].success, false);
    assert.equal(payload.results[0].exitCode, 1);
    assert.match(payload.results[0].error ?? "", /no output/i);
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

    await waitForAsyncResultFile(id, scaleTestTimeout(10_000));

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.equal(payload.success, false);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.results[0].success, false);
    assert.equal(payload.results[0].error, "provider exploded");
  });

  it("background interrupted runs still clean up owned process groups", async () => {
    mockPi.onCall({ delay: 10_000 });

    const id = `async-interrupt-cleanup-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
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
    assert.equal(status.steps?.[0]?.status, "paused");
    assert.equal(payload.summary, "Paused after interrupt. Waiting for explicit next action.");
    assert.ok(processCleanup, "expected background result to report process cleanup");
    assert.equal(processCleanup?.attempted, true);
    assert.equal(processCleanup?.terminated, true);
    assert.equal(processCleanup?.skippedReason, undefined);
    assert.equal(typeof processCleanup?.processGroupId, "number");
  });
});
