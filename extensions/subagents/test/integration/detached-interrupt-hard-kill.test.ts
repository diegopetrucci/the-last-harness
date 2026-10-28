/** Detached interrupt must SIGKILL a child that ignores SIGINT/SIGTERM, and let cooperative ones flush. */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createMockPi,
  createTempDir,
  makeAgent,
  makeExtensionAPI,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  ASYNC_DIR,
  requestAsyncInterrupt,
  startedMockPiPids,
  waitForAsyncResultFile,
  waitForAsyncState,
  waitForMockPiCall,
  waitForPidsToExit,
} from "../support/async-execution-helpers.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { PROCESS_GROUP_CLEANUP_MAX_WAIT_MS } from "../../src/runs/shared/process-group-cleanup.ts";

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

function launch(cwd: string, id: string) {
  executeAsyncSingle(id, {
    agent: "worker",
    task: "Run the detached child.",
    agentConfig: makeAgent("worker"),
    ctx: { pi: makeExtensionAPI({}), cwd, currentSessionId: "session-detached" },
    artifactConfig,
    shareEnabled: false,
    sessionRoot: path.join(cwd, "sessions", id),
    maxSubagentDepth: 2,
  });
}

describe("detached interrupt hard-kill", () => {
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
    tempDir = createTempDir("detached-interrupt-kill-");
    mockPi.reset();
  });
  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("SIGKILLs a child that ignores SIGINT and SIGTERM on interrupt within the cleanup bound", async () => {
    const id = `detached-interrupt-sigkill-${Date.now().toString(36)}`;
    mockPi.onCall({
      output: "stubborn child",
      ignoreSigint: true,
      ignoreSigterm: true,
      keepAliveAfterFinalMessageMs: 60_000,
    });
    launch(tempDir, id);
    await waitForMockPiCall(mockPi, 0);
    await waitForAsyncState(path.join(ASYNC_DIR, id), "running");
    const childPid = startedMockPiPids(mockPi)[0]!;
    const interruptedAt = Date.now();
    requestAsyncInterrupt(path.join(ASYNC_DIR, id), { source: "detached-hard-kill-test" });
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
      results: Array<{ processCleanup?: { terminated?: boolean } }>;
    };

    await waitForPidsToExit([childPid], "SIGTERM-ignoring mock child");
    assert.ok(
      Date.now() - interruptedAt < PROCESS_GROUP_CLEANUP_MAX_WAIT_MS + 5_000,
      "interrupt must SIGKILL within the cleanup bound",
    );
    assert.equal(payload.results[0]?.processCleanup?.terminated, true);
  });

  it("lets a cooperative child flush on SIGTERM before the runner exits", async () => {
    const id = `detached-interrupt-flush-${Date.now().toString(36)}`;
    const flushMarker = path.join(tempDir, "flushed-on-sigterm");
    mockPi.onCall({
      output: "cooperative child",
      ignoreSigint: true,
      flushMarkerOnSigterm: flushMarker,
      keepAliveAfterFinalMessageMs: 60_000,
    });
    launch(tempDir, id);
    await waitForMockPiCall(mockPi, 0);
    await waitForAsyncState(path.join(ASYNC_DIR, id), "running");
    const childPid = startedMockPiPids(mockPi)[0]!;
    requestAsyncInterrupt(path.join(ASYNC_DIR, id), { source: "detached-hard-kill-test" });
    await waitForAsyncResultFile(id);
    await waitForPidsToExit([childPid], "cooperative mock child");
    assert.ok(
      fs.existsSync(flushMarker),
      "child must receive SIGTERM and flush before any SIGKILL",
    );
  });

  it("SIGKILLs a SIGTERM-ignoring descendant after the cooperative group leader exits", async () => {
    const id = `detached-interrupt-descendant-${Date.now().toString(36)}`;
    const flushMarker = path.join(tempDir, "leader-flushed");
    mockPi.onCall({
      output: "cooperative leader",
      ignoreSigint: true,
      flushMarkerOnSigterm: flushMarker,
      spawnStubbornDescendants: true,
      keepAliveAfterFinalMessageMs: 60_000,
    });
    launch(tempDir, id);
    await waitForMockPiCall(mockPi, 0);
    await waitForAsyncState(path.join(ASYNC_DIR, id), "running");
    const leaderPid = startedMockPiPids(mockPi)[0]!;
    const { childPid, grandchildPid } = JSON.parse(
      fs.readFileSync(path.join(mockPi.dir, `descendants-${leaderPid}.json`), "utf-8"),
    ) as { childPid: number; grandchildPid: number };
    const interruptedAt = Date.now();
    requestAsyncInterrupt(path.join(ASYNC_DIR, id), { source: "detached-hard-kill-test" });
    await waitForAsyncResultFile(id);

    await waitForPidsToExit(
      [leaderPid, childPid, grandchildPid],
      "SIGTERM-ignoring descendants of a cooperative leader",
    );
    assert.ok(fs.existsSync(flushMarker), "leader must flush on SIGTERM");
    assert.ok(
      Date.now() - interruptedAt < PROCESS_GROUP_CLEANUP_MAX_WAIT_MS + 5_000,
      "descendants must be SIGKILLed within the cleanup bound",
    );
  });

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForLeaderExit(leaderPid: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (isAlive(leaderPid)) {
      if (Date.now() > deadline) throw new Error("leader did not exit normally");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function killQuietly(pids: number[]): void {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        void 0;
      }
    }
  }

  it("SIGKILLs stubborn descendants when aborted after the leader exited normally (#828)", async () => {
    const id = `awaited-abort-after-exit-${Date.now().toString(36)}`;
    const bus = createEventBus();
    const controller = new AbortController();
    mockPi.onCall({ output: "leader exits normally", spawnStubbornDescendants: true });

    const pending = executeAsyncSingle(
      id,
      singleParams(bus, tempDir, id, { signal: controller.signal }),
    );
    let pids: number[] = [];
    try {
      await waitForMockPiCall(mockPi, 0);
      const leaderPid = startedMockPiPids(mockPi)[0]!;
      const { childPid, grandchildPid } = JSON.parse(
        fs.readFileSync(path.join(mockPi.dir, `descendants-${leaderPid}.json`), "utf-8"),
      ) as { childPid: number; grandchildPid: number };
      pids = [childPid, grandchildPid];
      await waitForLeaderExit(leaderPid);
      assert.ok(pids.every(isAlive), "descendants must outlive the leader");
      const abortedAt = Date.now();
      controller.abort();
      const result = await pending;
      await waitForPidsToExit(pids, "stubborn descendants after normal leader exit");
      assert.ok(
        Date.now() - abortedAt < PROCESS_GROUP_CLEANUP_MAX_WAIT_MS + 5_000,
        "descendants must be SIGKILLed within the cleanup bound",
      );
      assert.equal(result.details.results[0]?.terminationReason, "cancelled");
    } finally {
      killQuietly(pids);
      await Promise.resolve(pending).catch(() => undefined);
    }
  });

  it("cleans up stubborn descendants after a normal leader exit without abort", async () => {
    const id = `awaited-no-abort-descendant-${Date.now().toString(36)}`;
    const bus = createEventBus();
    mockPi.onCall({ output: "leader exits normally", spawnStubbornDescendants: true });

    const pending = executeAsyncSingle(id, singleParams(bus, tempDir, id));
    let pids: number[] = [];
    try {
      await waitForMockPiCall(mockPi, 0);
      const leaderPid = startedMockPiPids(mockPi)[0]!;
      const { childPid, grandchildPid } = JSON.parse(
        fs.readFileSync(path.join(mockPi.dir, `descendants-${leaderPid}.json`), "utf-8"),
      ) as { childPid: number; grandchildPid: number };
      pids = [childPid, grandchildPid];
      await pending;
      await waitForPidsToExit(pids, "stubborn descendants without abort");
    } finally {
      killQuietly(pids);
      await Promise.resolve(pending).catch(() => undefined);
    }
  });
});
