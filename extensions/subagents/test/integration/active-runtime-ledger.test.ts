/**
 * Durable active-runtime ledger: runner death, revival charging, and
 * fail-closed handling of malformed persisted accounting (#770 budgets).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import {
  createBackgroundRunStatusOwner,
  type BackgroundRunStatusOwner,
} from "../../src/runs/background/run-status-owner.ts";
import { createAwaitedRunOwner } from "../../src/runs/background/awaited-run-owner.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import {
  ACTIVE_RUNTIME_CHECKPOINT_INTERVAL_MS,
  createActiveRuntimeTracker,
} from "../../src/runs/shared/active-runtime.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  createEventBus,
  createMockPi,
  createTempDir,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import {
  makeNativeResultLifecycleExecutor,
  readAsyncStatusJson,
  waitForRevivedAsyncResult,
} from "../support/native-result-lifecycle-fixtures.ts";

const INTERVAL = ACTIVE_RUNTIME_CHECKPOINT_INTERVAL_MS;
const DEAD_PID_KILL = (): boolean => {
  throw Object.assign(new Error("no such process"), { code: "ESRCH" });
};
const ARTIFACT_CONFIG = {
  mode: "compact" as const,
  enabled: false,
  includeInput: false,
  includeOutput: false,
  includeJsonl: false,
  includeTranscript: false,
  includeMetadata: false,
  includeChildEventProjections: false,
  cleanupDays: 7,
};

type StatusJson = {
  state?: string;
  steps?: Array<{ status?: string; activeRuntimeMs?: number; timeoutOwner?: string }>;
};

describe("durable active-runtime ledger", () => {
  let tempDir: string;
  let mockPi: MockPi;
  const cleanup: string[] = [];

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });
  after(() => mockPi.uninstall());
  beforeEach(() => {
    tempDir = createTempDir("pi-active-runtime-ledger-");
    mockPi.reset();
  });
  afterEach(() => {
    for (const entry of cleanup.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
    removeTempDir(tempDir);
  });

  function makeExecutor(maxExecutionTimeMs: number, names = ["worker"]) {
    return makeNativeResultLifecycleExecutor(tempDir, {
      agents: names.map((name) => makeAgent(name, { maxExecutionTimeMs })),
    });
  }

  /** Start a runner, run it for two checkpoint intervals, and checkpoint once. */
  function checkpointedRun(runId: string, names: string[], awaited: boolean) {
    const asyncDir = path.join(ASYNC_DIR, runId);
    cleanup.push(asyncDir, path.join(RESULTS_DIR, `${runId}.json`));
    const sessions = names.map((name) => path.join(tempDir, `${runId}-${name}.jsonl`));
    sessions.forEach((file) => fs.writeFileSync(file, "", "utf-8"));
    const task = (name: string, index: number) => ({
      agent: name,
      task: `work ${name}`,
      model: "mock/test-model",
      contextWindows: { "mock/test-model": 1_000 },
      inheritProjectContext: false,
      inheritSkills: false,
      sessionFile: sessions[index],
      timeoutMs: 1_000_000,
      timeoutOwner: "role" as const,
    });
    const startedAt = Date.now() - 2 * INTERVAL;
    const owner: BackgroundRunStatusOwner = createBackgroundRunStatusOwner({
      id: runId,
      asyncDir,
      cwd: tempDir,
      awaited,
      plan:
        names.length === 1
          ? { kind: "single", task: task(names[0]!, 0) }
          : {
              kind: "parallel",
              tasks: names.map(task),
            },
      overallStartTime: startedAt,
      artifactConfig: ARTIFACT_CONFIG,
      appendEvent() {},
    });
    owner.statusPayload.steps.forEach((step, index) => {
      step.status = "running";
      step.startedAt = startedAt;
      owner.activeRuntimeTrackers.set(
        index,
        createActiveRuntimeTracker({ priorActiveRuntimeMs: 0, segmentStartedAt: startedAt }),
      );
    });
    owner.writeStatusPayload();
    // One periodic tick one interval in; everything after it is lost when the
    // runner dies, so at most one interval can go uncharged.
    assert.equal(owner.checkpointActiveRuntime(startedAt + INTERVAL), true);
    return { asyncDir, sessions };
  }

  function assertPersistedCheckpoint(runId: string, children: number): void {
    const persisted = readAsyncStatusJson<StatusJson>(runId);
    assert.equal(persisted.state, "running");
    assert.equal(persisted.steps?.length, children);
    for (const step of persisted.steps ?? []) assert.equal(step.activeRuntimeMs, INTERVAL);
  }

  async function assertRevivalCharges(runId: string, names: string[], index?: number) {
    const selected = index ?? 0;
    // Persisted consumption exhausts a budget that equals it (the dead runner's
    // last checkpoint is charged, never forgotten).
    const tight = makeExecutor(INTERVAL, names);
    const refused = await tight.executor.execute(
      "ledger-exhausted",
      { action: "resume", id: runId, ...(index === undefined ? {} : { index }), message: "go" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(refused.isError, true);
    assert.match(
      refused.content[0]?.text ?? "",
      new RegExp(
        `Agent '${names[selected]}' has exhausted its maxExecutionTimeMs ceiling after ${INTERVAL}ms of active runtime\\.`,
      ),
    );
    assert.equal(mockPi.callCount(), 0, "an exhausted instance must not relaunch");

    // A larger budget revives it with the persisted consumption carried forward.
    mockPi.onCall({ output: "revived after runner death" });
    const roomy = makeExecutor(INTERVAL + scaleTestTimeout(60_000), names);
    const revived = await roomy.executor.execute(
      "ledger-revived",
      { action: "resume", id: runId, ...(index === undefined ? {} : { index }), message: "go" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(revived.isError, undefined, revived.content[0]?.text ?? "");
    const revivedId = await waitForRevivedAsyncResult(revived);
    cleanup.push(path.join(ASYNC_DIR, revivedId), path.join(RESULTS_DIR, `${revivedId}.json`));
    const revivedStatus = readAsyncStatusJson<StatusJson>(revivedId);
    assert.ok(
      (revivedStatus.steps?.[0]?.activeRuntimeMs ?? 0) >= INTERVAL,
      `revived run must start from the persisted ${INTERVAL}ms, got ${revivedStatus.steps?.[0]?.activeRuntimeMs}`,
    );
  }

  it("detached single run: runner death then revival charges the last checkpoint", async () => {
    const runId = `ledger-detached-single-${Date.now()}`;
    const { asyncDir } = checkpointedRun(runId, ["worker"], false);
    assertPersistedCheckpoint(runId, 1);
    // Runner death: the pid is gone and no terminal artifact was written.
    const statusPath = path.join(asyncDir, "status.json");
    const dead = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
    dead.pid = 999_991;
    fs.writeFileSync(statusPath, JSON.stringify(dead), "utf-8");
    const reconciled = reconcileAsyncRun(asyncDir, { kill: DEAD_PID_KILL });
    assert.equal(reconciled.repaired, true);
    assert.equal(readAsyncStatusJson<StatusJson>(runId).state, "failed");
    await assertRevivalCharges(runId, ["worker"]);
  });

  it("detached parallel run: every child keeps its checkpoint through runner death", async () => {
    const runId = `ledger-detached-parallel-${Date.now()}`;
    const { asyncDir } = checkpointedRun(runId, ["a", "b"], false);
    assertPersistedCheckpoint(runId, 2);
    const statusPath = path.join(asyncDir, "status.json");
    const dead = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
    dead.pid = 999_992;
    fs.writeFileSync(statusPath, JSON.stringify(dead), "utf-8");
    assert.equal(reconcileAsyncRun(asyncDir, { kill: DEAD_PID_KILL }).repaired, true);
    await assertRevivalCharges(runId, ["a", "b"], 1);
  });

  it("awaited run: runner death settled by the awaited owner still charges the checkpoint", async () => {
    const runId = `ledger-awaited-${Date.now()}`;
    const { asyncDir } = checkpointedRun(runId, ["worker"], true);
    assertPersistedCheckpoint(runId, 1);
    assert.equal(readAsyncStatusJson<{ awaited?: boolean }>(runId).awaited, true);
    const statusPath = path.join(asyncDir, "status.json");
    const dead = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
    dead.pid = 999_993;
    fs.writeFileSync(statusPath, JSON.stringify(dead), "utf-8");
    const events = createEventBus();
    const owner = createAwaitedRunOwner({
      id: runId,
      asyncDir,
      resultPath: path.join(RESULTS_DIR, `${runId}.json`),
      mode: "single",
      plan: {
        kind: "single",
        task: {
          agent: "worker",
          task: "work",
          contextWindows: { "mock/test-model": 1_000 },
          inheritProjectContext: false,
          inheritSkills: false,
        },
      },
      events,
      expectedGeneration: 0,
      pollIntervalMs: 5,
      cleanupGraceMs: 20,
      pidLiveness: () => "dead",
    });
    owner.markSpawned(999_993);
    const settled = await owner.promise;
    owner.dispose();
    assert.equal(settled.isError, true);
    // The awaited owner reports failure to the caller; the stale-run reconciler
    // then settles the durable lifecycle record exactly as for a detached run.
    assert.equal(reconcileAsyncRun(asyncDir, { kill: DEAD_PID_KILL }).repaired, true);
    await assertRevivalCharges(runId, ["worker"]);
  });

  describe("malformed persisted accounting fails closed", () => {
    const cases: Array<{ label: string; step: Record<string, unknown>; match: RegExp }> = [
      {
        label: "negative activeRuntimeMs",
        step: { activeRuntimeMs: -5 },
        match: /status activeRuntimeMs for child 0 is malformed/,
      },
      {
        label: "non-numeric activeRuntimeMs",
        step: { activeRuntimeMs: "100" },
        match: /status activeRuntimeMs for child 0 is malformed/,
      },
      {
        label: "malformed activeRuntimeCheckpointAt",
        step: { activeRuntimeMs: 100, activeRuntimeCheckpointAt: "yesterday" },
        match: /status activeRuntimeCheckpointAt for child 0 is malformed/,
      },
      {
        label: "malformed timeoutOwner",
        step: { timedOut: true, timeoutOwner: "ROLE", activeRuntimeMs: 100 },
        match: /status timeoutOwner for child 0 is malformed/,
      },
    ];
    for (const entry of cases) {
      it(`rejects continuation and leaves artifacts unchanged: ${entry.label}`, async () => {
        const runId = `ledger-malformed-${Date.now()}-${entry.label.replace(/\W+/g, "-")}`;
        const asyncDir = path.join(ASYNC_DIR, runId);
        const statusPath = path.join(asyncDir, "status.json");
        const sessionFile = path.join(tempDir, `${runId}.jsonl`);
        cleanup.push(asyncDir);
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(sessionFile, "", "utf-8");
        fs.writeFileSync(
          statusPath,
          JSON.stringify({
            runId,
            mode: "single",
            state: "failed",
            startedAt: 100,
            endedAt: 200,
            lastUpdate: 200,
            cwd: tempDir,
            steps: [{ agent: "worker", status: "failed", sessionFile, ...entry.step }],
          }),
          "utf-8",
        );
        const before = fs.readFileSync(statusPath);
        const { executor } = makeExecutor(scaleTestTimeout(60_000));
        const result = await executor.execute(
          "ledger-malformed",
          { action: "resume", id: runId, message: "go" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", entry.match);
        assert.match(result.content[0]?.text ?? "", /Repair or remove it/);
        assert.equal(mockPi.callCount(), 0, "malformed accounting must not spawn");
        assert.deepEqual(fs.readFileSync(statusPath), before);
      });
    }

    async function resumeRejected(runId: string, match: RegExp): Promise<void> {
      const { executor } = makeExecutor(scaleTestTimeout(60_000));
      const result = await executor.execute(
        "ledger-malformed",
        { action: "resume", id: runId, message: "go" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", match);
      assert.equal(mockPi.callCount(), 0, "malformed accounting must not spawn");
    }

    function writeCorruptRun(
      runId: string,
      state: string,
      step: Record<string, unknown>,
      pid?: number,
    ): { asyncDir: string; statusPath: string } {
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      cleanup.push(asyncDir);
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      const statusPath = path.join(asyncDir, "status.json");
      fs.writeFileSync(
        statusPath,
        JSON.stringify({
          runId,
          mode: "single",
          state,
          startedAt: 100,
          lastUpdate: 200,
          cwd: tempDir,
          ...(pid ? { pid } : {}),
          steps: [{ agent: "worker", status: state, sessionFile, ...step }],
        }),
        "utf-8",
      );
      return { asyncDir, statusPath };
    }

    for (const step of [
      { activeRuntimeMs: -5 },
      { activeRuntimeMs: "100" },
      { activeRuntimeMs: 100, activeRuntimeCheckpointAt: "yesterday" },
    ]) {
      it(`rejects corruption under normal role ownership: ${JSON.stringify(step)}`, async () => {
        const runId = `ledger-role-owned-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const { statusPath } = writeCorruptRun(runId, "failed", {
          timeoutOwner: "role",
          ...step,
        });
        const before = fs.readFileSync(statusPath);
        await resumeRejected(runId, /status activeRuntime\w+ for child 0 is malformed/);
        assert.deepEqual(fs.readFileSync(statusPath), before);
      });
    }

    it("rejects dead-PID corruption before stale repair with byte-identical artifacts", async () => {
      const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
      const runId = `ledger-dead-pid-${Date.now()}`;
      const { statusPath } = writeCorruptRun(runId, "running", { activeRuntimeMs: -5 }, deadPid);
      const before = fs.readFileSync(statusPath);
      await resumeRejected(runId, /status activeRuntimeMs for child 0 is malformed/);
      assert.deepEqual(fs.readFileSync(statusPath), before);
    });

    it("keeps malformed evidence through stale repair so a later resume fails closed", async () => {
      const runId = `ledger-stale-then-resume-${Date.now()}`;
      const { asyncDir, statusPath } = writeCorruptRun(
        runId,
        "running",
        { activeRuntimeMs: -5, timeoutOwner: "ROLE" },
        999_994,
      );
      const repaired = reconcileAsyncRun(asyncDir, { kill: DEAD_PID_KILL });
      assert.equal(repaired.repaired, true);
      const persisted = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
      assert.equal(persisted.state, "failed");
      assert.equal(persisted.steps[0].activeRuntimeMs, -5);
      assert.equal(persisted.steps[0].timeoutOwner, "ROLE");
      const before = fs.readFileSync(statusPath);
      await resumeRejected(runId, /status (activeRuntimeMs|timeoutOwner) for child 0 is malformed/);
      assert.deepEqual(fs.readFileSync(statusPath), before);
    });

    it("rejects malformed result-side accounting", async () => {
      const runId = `ledger-malformed-result-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const resultPath = path.join(RESULTS_DIR, `${runId}.json`);
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      cleanup.push(asyncDir, resultPath);
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: runId,
          agent: "worker",
          success: false,
          state: "failed",
          cwd: tempDir,
          results: [{ agent: "worker", success: false, sessionFile, timeoutOwner: "everyone" }],
        }),
        "utf-8",
      );
      const before = fs.readFileSync(resultPath);
      const { executor } = makeExecutor(scaleTestTimeout(60_000));
      const result = await executor.execute(
        "ledger-malformed-result",
        { action: "resume", id: runId, message: "go" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /timeoutOwner must be "role" or "run"/);
      assert.equal(mockPi.callCount(), 0);
      assert.deepEqual(fs.readFileSync(resultPath), before);
    });

    it("status/result disagreement keeps the larger runtime and the role poison", async () => {
      const runId = `ledger-disagree-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const resultPath = path.join(RESULTS_DIR, `${runId}.json`);
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      cleanup.push(asyncDir, resultPath);
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      // Status undercounts and claims a malformed owner; the result carries the
      // authoritative role-timeout evidence. Neither may widen the budget.
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId,
          mode: "single",
          state: "failed",
          startedAt: 100,
          endedAt: 200,
          lastUpdate: 200,
          cwd: tempDir,
          steps: [
            {
              agent: "worker",
              status: "failed",
              sessionFile,
              timedOut: true,
              timeoutOwner: "ROLE",
              activeRuntimeMs: 1,
            },
          ],
        }),
        "utf-8",
      );
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: runId,
          agent: "worker",
          success: false,
          state: "failed",
          cwd: tempDir,
          results: [
            {
              agent: "worker",
              success: false,
              sessionFile,
              timedOut: true,
              timeoutOwner: "role",
              activeRuntimeMs: 50_000,
            },
          ],
        }),
        "utf-8",
      );
      const { executor } = makeExecutor(scaleTestTimeout(60_000));
      const result = await executor.execute(
        "ledger-disagree",
        { action: "resume", id: runId, message: "go" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /permanently retires this instance/);
      assert.equal(mockPi.callCount(), 0);
    });

    it("accepts absent legacy accounting metadata", async () => {
      const runId = `ledger-legacy-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      cleanup.push(asyncDir);
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId,
          mode: "single",
          state: "complete",
          startedAt: 100,
          endedAt: 200,
          lastUpdate: 200,
          cwd: tempDir,
          steps: [{ agent: "worker", status: "complete", sessionFile }],
        }),
        "utf-8",
      );
      mockPi.onCall({ output: "legacy revived" });
      const { executor } = makeExecutor(scaleTestTimeout(60_000));
      const result = await executor.execute(
        "ledger-legacy",
        { action: "resume", id: runId, message: "go" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
      const revivedId = await waitForRevivedAsyncResult(result);
      cleanup.push(path.join(ASYNC_DIR, revivedId), path.join(RESULTS_DIR, `${revivedId}.json`));
    });
  });
});
