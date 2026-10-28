import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildSubagentRunTelemetry,
  type SubagentTelemetryProvenance,
} from "../../src/shared/telemetry.ts";
import {
  buildPausedRunnerTelemetry,
  persistRunnerTerminalRun,
  type RunnerStepResult,
} from "../../src/runs/background/terminal-persistence.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import {
  createBackgroundRunStatusOwner,
  type RunnerStatusPayload,
} from "../../src/runs/background/run-status-owner.ts";
import { writeNormalizedLifecycleStatus } from "../../src/runs/shared/lifecycle-state.ts";
import type { ResolvedControlConfig, CostSummary, TokenUsage } from "../../src/shared/types.ts";

const controls: ResolvedControlConfig = {
  enabled: true,
  needsAttentionAfterMs: 2_000,
  notifyOn: ["needs_attention"],
  notifyChannels: ["event", "async"],
};

const provenance: SubagentTelemetryProvenance = {
  tlhVersion: "test-tlh",
  piVersion: "test-pi",
  installGeneration: "test-generation",
  loadedAt: 123,
};

const cost: CostSummary = { inputTokens: 2, outputTokens: 3, costUsd: 0.5 };
const tokens: TokenUsage = { input: 2, output: 3, total: 5 };
const tempDirs: string[] = [];

const terminalPlan = {
  kind: "single" as const,
  task: {
    agent: "worker",
    task: "task",
    inheritProjectContext: false,
    inheritSkills: false,
  },
};
const terminalArtifactConfig = {
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createDirectStatusOwner(root: string, id: string) {
  const asyncDir = path.join(root, "async");
  const owner = createBackgroundRunStatusOwner({
    id,
    asyncDir,
    cwd: root,
    plan: terminalPlan,
    overallStartTime: 100,
    artifactConfig: terminalArtifactConfig,
    appendEvent: () => undefined,
  });
  return { owner, asyncDir };
}

describe("terminal persistence", () => {
  it("recomputes result, event, and log from a post-pause adopted status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-terminal-persistence-"));
    tempDirs.push(root);
    const id = "terminal-adoption-projection";
    const resultPath = path.join(root, "result.json");
    const asyncDir = path.join(root, "async");
    const launchTelemetry = buildSubagentRunTelemetry({
      runId: id,
      execution: "async",
      mode: "single",
      provenance,
      controls,
      startedAt: 100,
      outcome: { state: "running" },
      steps: [{ index: 0, agent: "worker", outcome: { state: "queued" } }],
    });
    const canonicalTelemetry = buildSubagentRunTelemetry({
      runId: id,
      execution: "async",
      mode: "single",
      provenance,
      controls,
      startedAt: 100,
      endedAt: 200,
      lineage: {
        continuations: [{ sourceStepIndex: 0, continuationRunId: "continuation-1" }],
      },
      outcome: { state: "continued" },
      steps: [{ index: 0, agent: "worker", outcome: { state: "continued" } }],
    });
    const statusPayload: RunnerStatusPayload = {
      runId: id,
      mode: "single",
      state: "paused",
      startedAt: 100,
      endedAt: 150,
      lastUpdate: 150,
      cwd: root,
      currentStep: 0,
      steps: [{ agent: "worker", status: "paused", startedAt: 100, endedAt: 150 }],
      totalTokens: { input: 1, output: 1, total: 2 },
      totalCost: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 },
    };
    let lockedWriteCount = 0;
    const statusOwner = Object.assign(
      {} as Parameters<typeof persistRunnerTerminalRun>[0]["statusOwner"],
      {
        terminalReason: {},
        interrupted: true,
        timedOut: false,
        supervisorPauseTransitionFailed: false,
        concurrentTerminalStatusAdopted: false,
        supervisorPauseRequest: { requesterIndex: 0 },
        writeStatusPayload: () => {
          lockedWriteCount += 1;
          Object.assign(statusPayload, {
            state: "continued",
            pause: undefined,
            endedAt: 200,
            lastUpdate: 200,
            totalTokens: tokens,
            totalCost: cost,
            steps: [{ agent: "worker", status: "continued", startedAt: 100, endedAt: 200 }],
            telemetry: canonicalTelemetry,
          });
        },
      },
    );
    const events: Array<Record<string, unknown>> = [];
    const logs: unknown[] = [];
    const result: RunnerStepResult = {
      agent: "worker",
      output: "child output",
      success: true,
      exitCode: 0,
    };

    persistRunnerTerminalRun({
      config: {
        id,
        telemetry: launchTelemetry,
        plan: {
          kind: "single",
          task: {
            agent: "worker",
            task: "task",
            inheritProjectContext: false,
            inheritSkills: false,
          },
        },
        resultPath,
        cwd: root,
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
        asyncDir,
      },
      plan: {
        kind: "single",
        task: {
          agent: "worker",
          task: "task",
          inheritProjectContext: false,
          inheritSkills: false,
        },
      },
      statusOwner,
      statusPayload,
      results: [result],
      controlConfig: controls,
      overallStartTime: 100,
      runEndedAt: 175,
      effectiveSessionFile: path.join(root, "stale-session.jsonl"),
      finalTotalCost: { inputTokens: 9, outputTokens: 9, costUsd: 9 },
      summary: "stale source summary",
      truncated: false,
      agentName: "worker",
      resultPath,
      cwd: root,
      artifactsDir: path.join(root, "stale-artifacts"),
      asyncDir,
      pausedAwaitingSupervisor: { kind: "awaiting_supervisor", ownerPid: undefined },
      skipFinalStatusWrite: false,
      pausedOutputForIndex: () => "paused source output",
      appendEvent: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
      writeRunLog: (input) => logs.push(input),
    });

    assert.equal(lockedWriteCount, 1);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      type: "subagent.run.completed",
      lifecycleArtifactVersion: 1,
      ts: 200,
      runId: id,
      status: "continued",
      durationMs: 100,
      totalTokens: tokens,
      totalCost: cost,
    });
    const log = logs[0] as {
      startedAt: number;
      endedAt: number;
      summary: string;
      steps: Array<{ status: string }>;
    };
    assert.equal(log.startedAt, 100);
    assert.equal(log.endedAt, 200);
    assert.equal(log.summary, "stale source summary");
    assert.deepEqual(
      log.steps.map((step) => step.status),
      ["continued"],
    );

    const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      state: string;
      pause?: unknown;
      timestamp: number;
      durationMs: number;
      totalTokens?: TokenUsage;
      totalCost?: CostSummary;
      telemetry?: unknown;
    };
    assert.equal(artifact.state, "continued");
    assert.equal(artifact.pause, undefined);
    assert.equal(artifact.timestamp, 200);
    assert.equal(artifact.durationMs, 100);
    assert.deepEqual(artifact.totalTokens, tokens);
    assert.deepEqual(artifact.totalCost, cost);
    assert.deepEqual(artifact.telemetry, canonicalTelemetry);
  });

  it("releases interrupted ownership after cleanup so a reused pid cannot block resume", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-terminal-interrupt-release-"));
    tempDirs.push(root);
    const id = "terminal-interrupt-release";
    const asyncRoot = path.join(root, "runs");
    const asyncDir = path.join(asyncRoot, id);
    const resultsDir = path.join(root, "results");
    const resultPath = path.join(resultsDir, `${id}.json`);
    const sessionFile = path.join(root, "worker-session.jsonl");
    const oldPid = 4242;
    const pause = {
      kind: "cohort_pause" as const,
      summary: "Paused after interrupt.",
      ownerPid: oldPid,
    };
    fs.writeFileSync(sessionFile, "", "utf-8");

    const owner = createBackgroundRunStatusOwner({
      id,
      asyncDir,
      cwd: root,
      plan: terminalPlan,
      overallStartTime: 100,
      artifactConfig: terminalArtifactConfig,
      appendEvent: () => undefined,
    });
    owner.statusPayload.state = "paused";
    owner.statusPayload.pid = oldPid;
    owner.statusPayload.sessionFile = sessionFile;
    owner.statusPayload.pause = pause;
    owner.statusPayload.steps = owner.statusPayload.steps.map((step) => ({
      ...step,
      status: "paused",
      startedAt: 100,
      endedAt: 200,
      sessionFile,
      pause,
      processCleanup: { supported: true, attempted: true, terminated: true },
    }));
    owner.interrupted = true;
    writeNormalizedLifecycleStatus(asyncDir, owner.statusPayload);

    const result: RunnerStepResult = {
      agent: "worker",
      output: "Paused after interrupt.",
      success: false,
      exitCode: 0,
      interrupted: true,
      sessionFile,
      pause,
    };
    persistRunnerTerminalRun({
      config: {
        id,
        plan: terminalPlan,
        resultPath,
        cwd: root,
        artifactConfig: terminalArtifactConfig,
        asyncDir,
      },
      plan: terminalPlan,
      statusOwner: owner,
      statusPayload: owner.statusPayload,
      results: [result],
      controlConfig: controls,
      overallStartTime: 100,
      runEndedAt: 200,
      effectiveSessionFile: sessionFile,
      summary: "Paused after interrupt.",
      truncated: false,
      agentName: "worker",
      resultPath,
      cwd: root,
      asyncDir,
      pausedOwnershipConfirmedStopped: true,
      skipFinalStatusWrite: false,
      pausedOutputForIndex: () => "Paused after interrupt.",
      appendEvent: () => undefined,
      writeRunLog: () => undefined,
    });

    const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as {
      state: string;
      pid?: number;
      pause?: { ownerPid?: number };
      steps: Array<{ pause?: { ownerPid?: number } }>;
    };
    assert.equal(persisted.state, "paused");
    assert.equal(persisted.pid, undefined);
    assert.equal(persisted.pause?.ownerPid, undefined);
    assert.equal(persisted.steps[0]?.pause?.ownerPid, undefined);

    const artifact = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
      pause?: { ownerPid?: number };
      results: Array<{ pause?: { ownerPid?: number } }>;
    };
    assert.equal(artifact.pause?.ownerPid, undefined);
    assert.equal(artifact.results[0]?.pause?.ownerPid, undefined);

    // A late status write from the drained runner must not resurrect ownership.
    owner.writeStatusPayload();
    const afterLateWrite = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as typeof persisted;
    assert.equal(afterLateWrite.pid, undefined);
    assert.equal(afterLateWrite.pause?.ownerPid, undefined);
    assert.equal(afterLateWrite.steps[0]?.pause?.ownerPid, undefined);

    let livenessProbes = 0;
    const target = resolveAsyncResumeTarget(
      { id },
      {
        asyncDirRoot: asyncRoot,
        resultsDir,
        // This simulates the old pid being alive after reuse. A durable clear
        // means resume should not probe or block on that unrelated process.
        kill: () => {
          livenessProbes++;
          return true;
        },
      },
    );
    assert.equal(target.kind, "revive");
    assert.equal(target.sessionFile, sessionFile);
    assert.equal(livenessProbes, 0);
  });

  it("preserves direct status timestamps across locked and unlocked writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-direct-status-clock-"));
    tempDirs.push(root);
    const { owner, asyncDir } = createDirectStatusOwner(root, "direct-clock");

    writeNormalizedLifecycleStatus(asyncDir, {
      ...owner.statusPayload,
      lastUpdate: 120,
    });
    owner.writeStatusPayload({ lifecycleLocked: true });
    assert.equal(owner.statusPayload.lastUpdate, 120);

    owner.writeStatusPayload();
    const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as {
      lastUpdate?: number;
    };
    assert.equal(persisted.lastUpdate, 120);
  });

  it("preserves the paused timestamp floor when adopting continued or cancelled status", () => {
    for (const adoptedState of ["continued", "cancelled"] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `tlh-direct-adoption-${adoptedState}-`));
      tempDirs.push(root);
      const { owner, asyncDir } = createDirectStatusOwner(root, `direct-${adoptedState}`);
      owner.statusPayload.state = "paused";
      owner.statusPayload.endedAt = 120;
      owner.statusPayload.lastUpdate = 120;
      owner.statusPayload.pause = { kind: "awaiting_supervisor", pausedAt: 120 };
      owner.statusPayload.steps = owner.statusPayload.steps.map((step) => ({
        ...step,
        status: "paused",
        endedAt: 120,
        pause: { kind: "awaiting_supervisor", pausedAt: 120 },
      }));
      writeNormalizedLifecycleStatus(asyncDir, owner.statusPayload);

      const adoptedStatus: RunnerStatusPayload = {
        ...owner.statusPayload,
        state: adoptedState,
        endedAt: 110,
        lastUpdate: 110,
        pause: undefined,
        cancel:
          adoptedState === "cancelled"
            ? { summary: "cancelled by test", cancelledAt: 110 }
            : undefined,
        steps: owner.statusPayload.steps.map((step) => ({
          ...step,
          status: adoptedState,
          endedAt: 110,
          pause: undefined,
        })),
      };
      writeNormalizedLifecycleStatus(asyncDir, adoptedStatus);

      owner.writeStatusPayload({ lifecycleLocked: true });
      const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as {
        state: string;
        lastUpdate?: number;
      };
      // The branch normalizes "continued" → "complete" on disk; "cancelled" is
      // preserved as-is. Both cases must preserve the paused timestamp floor.
      const expectedState = adoptedState === "continued" ? "complete" : adoptedState;
      assert.equal(persisted.state, expectedState);
      assert.equal(persisted.lastUpdate, 120);
      assert.equal(owner.statusPayload.lastUpdate, 120);
    }
  });

  it("prefers a later timed-out step over an earlier failed sibling", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-terminal-persistence-timeout-"));
    tempDirs.push(root);
    const id = "parallel-timeout-error";
    const asyncDir = path.join(root, "async");
    const resultPath = path.join(root, "result.json");
    const ordinaryError = "ordinary sibling failed";
    const timeoutError = "Subagent timed out after 50ms.";
    const plan = {
      kind: "parallel" as const,
      tasks: [
        {
          agent: "failed-first",
          task: "fail",
          inheritProjectContext: false,
          inheritSkills: false,
        },
        {
          agent: "timed-out-later",
          task: "time out",
          inheritProjectContext: false,
          inheritSkills: false,
        },
      ],
    };
    const launchTelemetry = buildSubagentRunTelemetry({
      runId: id,
      execution: "async",
      mode: "parallel",
      provenance,
      controls,
      startedAt: 100,
      outcome: { state: "running" },
      steps: [
        { index: 0, agent: "failed-first", outcome: { state: "running" } },
        { index: 1, agent: "timed-out-later", outcome: { state: "running" } },
      ],
    });
    const owner = createBackgroundRunStatusOwner({
      id,
      asyncDir,
      cwd: root,
      plan,
      overallStartTime: 100,
      artifactConfig: terminalArtifactConfig,
      telemetry: launchTelemetry,
      timeoutMessage: timeoutError,
      appendEvent: () => undefined,
    });
    owner.statusPayload.steps[0] = {
      ...owner.statusPayload.steps[0]!,
      status: "failed",
      error: ordinaryError,
      exitCode: 1,
    };
    owner.statusPayload.steps[1] = {
      ...owner.statusPayload.steps[1]!,
      status: "failed",
      error: timeoutError,
      exitCode: 1,
      timedOut: true,
      terminationReason: "timed_out",
    };
    const results: RunnerStepResult[] = [
      {
        agent: "failed-first",
        output: "",
        error: ordinaryError,
        success: false,
        exitCode: 1,
      },
      {
        agent: "timed-out-later",
        output: "",
        error: timeoutError,
        success: false,
        exitCode: 1,
        timedOut: true,
        terminationReason: "timed_out",
      },
    ];

    persistRunnerTerminalRun({
      config: {
        id,
        telemetry: launchTelemetry,
        plan,
        resultPath,
        cwd: root,
        artifactConfig: terminalArtifactConfig,
        asyncDir,
      },
      plan,
      statusOwner: owner,
      statusPayload: owner.statusPayload,
      results,
      controlConfig: controls,
      overallStartTime: 100,
      runEndedAt: 150,
      summary: "ordinary sibling summary",
      truncated: false,
      agentName: "parallel",
      timeoutMessage: timeoutError,
      resultPath,
      cwd: root,
      asyncDir,
      skipFinalStatusWrite: false,
      pausedOutputForIndex: () => "paused source output",
      appendEvent: () => undefined,
      writeRunLog: () => undefined,
    });

    const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as {
      state: string;
      error?: string;
      timedOut?: boolean;
      steps: Array<{ error?: string }>;
    };
    assert.equal(status.state, "failed");
    assert.equal(status.timedOut, true);
    assert.equal(status.error, timeoutError);
    assert.deepEqual(
      status.steps.map((step) => step.error),
      [ordinaryError, timeoutError],
    );

    const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      state: string;
      summary: string;
      error?: string;
      timedOut?: boolean;
      telemetry?: { outcome?: { state?: string; terminationReason?: string } };
      results: Array<{ error?: string }>;
    };
    assert.equal(artifact.state, "failed");
    assert.equal(artifact.timedOut, true);
    assert.equal(artifact.summary, timeoutError);
    assert.equal(artifact.error, timeoutError);
    // The durable terminal record is written alongside (before) the notification file.
    const record = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "terminal-record.json"), "utf8"),
    ) as { state: string; children: Array<{ index: number; status: string }> };
    assert.equal(record.state, "failed");
    assert.deepEqual(
      record.children.map((child) => child.status),
      ["failed", "failed"],
    );
    assert.deepEqual(
      artifact.results.map((result) => result.error),
      [ordinaryError, timeoutError],
    );
    assert.deepEqual(artifact.telemetry?.outcome, {
      state: "failed",
      terminationReason: "timed_out",
    });
  });

  it("writes exitCode 1 and preserves cancel metadata for cancelled result artifacts", () => {
    // Regression test: resultItems() was missing the step-level cancel field
    // and the top-level exitCode was 0 instead of 1 for cancelled runs.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-terminal-persistence-cancel-"));
    tempDirs.push(root);
    const id = "terminal-cancel-exitcode";
    const resultPath = path.join(root, "result.json");
    const asyncDir = path.join(root, "async");
    const cancel: import("../../src/shared/types.ts").AsyncCancellationMetadata = {
      summary: "Cancelled by parent abort.",
      cancelledAt: 150,
    };
    const statusPayload: RunnerStatusPayload = {
      runId: id,
      mode: "single",
      state: "cancelled",
      startedAt: 100,
      endedAt: 150,
      lastUpdate: 150,
      cancel,
      error: cancel.summary,
      cwd: root,
      currentStep: 0,
      steps: [
        {
          agent: "worker",
          status: "cancelled",
          startedAt: 100,
          endedAt: 150,
          cancel,
          terminationReason: "cancelled",
          exitCode: 1,
        },
      ],
    };
    const statusOwner = Object.assign(
      {} as Parameters<typeof persistRunnerTerminalRun>[0]["statusOwner"],
      {
        terminalReason: {},
        interrupted: false,
        timedOut: false,
        supervisorPauseTransitionFailed: false,
        concurrentTerminalStatusAdopted: false,
        supervisorPauseRequest: undefined,
        writeStatusPayload: () => {},
      },
    );
    const result: RunnerStepResult = {
      agent: "worker",
      output: "cancelled output",
      success: false,
      exitCode: 1,
      cancel,
      terminationReason: "cancelled",
    };
    const events: Array<Record<string, unknown>> = [];
    persistRunnerTerminalRun({
      config: {
        id,
        plan: terminalPlan,
        resultPath,
        cwd: root,
        artifactConfig: terminalArtifactConfig,
        asyncDir,
      },
      plan: terminalPlan,
      statusOwner,
      statusPayload,
      results: [result],
      controlConfig: controls,
      overallStartTime: 100,
      runEndedAt: 150,
      summary: "Cancelled by parent abort.",
      truncated: false,
      agentName: "worker",
      resultPath,
      cwd: root,
      asyncDir,
      skipFinalStatusWrite: true,
      pausedOutputForIndex: () => "",
      appendEvent: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
      writeRunLog: () => {},
    });

    assert.ok(fs.existsSync(resultPath), "result artifact must be written");
    const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      state: string;
      exitCode: number;
      results: Array<{
        agent: string;
        exitCode?: number;
        cancel?: { summary: string; cancelledAt: number };
      }>;
    };
    assert.equal(artifact.state, "cancelled");
    assert.equal(artifact.exitCode, 1, "cancelled artifact top-level exitCode must be 1");
    assert.equal(
      artifact.results[0]?.cancel?.summary,
      cancel.summary,
      "step cancel.summary must be propagated into the result artifact",
    );
    assert.equal(
      artifact.results[0]?.cancel?.cancelledAt,
      cancel.cancelledAt,
      "step cancel.cancelledAt must be propagated into the result artifact",
    );
    assert.equal(artifact.results[0]?.exitCode, 1, "step exitCode must be 1 for cancelled step");
  });
});

// ---------------------------------------------------------------------------
// BUG-02: per-child cwd in runner result items
// RunnerStepResult.cwd must be written into the result.json step so that
// result-only revival (status.json absent) can use the correct child cwd.
// ---------------------------------------------------------------------------

describe("runner result item carries per-child cwd (BUG-02)", () => {
  it("resultItems writes cwd from RunnerStepResult into the result artifact step", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tp-stepcwd-"));
    tempDirs.push(root);
    const asyncDir = path.join(root, "async");
    const resultPath = path.join(root, "result.json");
    const sessionFile = path.join(root, "session.jsonl");
    fs.writeFileSync(sessionFile, "");

    const runCwd = path.join(root, "run-dir");
    const childCwd = path.join(root, "child-dir");

    const plan = terminalPlan;
    const owner = createBackgroundRunStatusOwner({
      id: "tp-stepcwd-1",
      asyncDir,
      cwd: runCwd,
      plan,
      overallStartTime: Date.now(),
      artifactConfig: terminalArtifactConfig,
      appendEvent() {},
    });

    const results: RunnerStepResult[] = [
      {
        agent: "worker",
        output: "done",
        success: true,
        exitCode: 0,
        sessionFile,
        cwd: childCwd,
      },
    ];

    persistRunnerTerminalRun({
      config: {
        id: "tp-stepcwd-1",
        plan,
        resultPath,
        cwd: runCwd,
        artifactConfig: terminalArtifactConfig,
        asyncDir,
      },
      plan,
      statusOwner: owner,
      statusPayload: owner.statusPayload,
      results,
      controlConfig: controls,
      overallStartTime: 100,
      runEndedAt: 200,
      summary: "done",
      truncated: false,
      agentName: "worker",
      resultPath,
      cwd: runCwd,
      asyncDir,
      skipFinalStatusWrite: false,
      pausedOutputForIndex: () => "paused",
      appendEvent() {},
      writeRunLog() {},
    });

    const artifact = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      cwd: string;
      results: Array<{ cwd?: string }>;
    };

    assert.equal(
      artifact.results[0]?.cwd,
      childCwd,
      "result artifact step must carry the per-child cwd, not the run cwd",
    );
    assert.equal(artifact.cwd, runCwd, "result artifact top-level cwd must still be the run cwd");
  });
});

describe("buildPausedRunnerTelemetry execution label", () => {
  it("sets execution to 'async' for the first committed paused status of a run", () => {
    // New runs only ever emit execution='async'.
    const config = {
      id: "paused-async",
      plan: terminalPlan,
      resultPath: "/tmp/paused-async.json",
      cwd: "/tmp",
      asyncDir: "/tmp",
      artifactConfig: terminalArtifactConfig,
      controlConfig: controls,
      telemetry: {
        schemaVersion: 1 as const,
        run: { id: "paused-async", execution: "async" as const, mode: "single" as const },
        steps: [],
        provenance,
        controls: {
          needsAttentionAfterMs: 2_000,
          failedToolAttemptsBeforeAttention: 3,
          notifyOn: ["needs_attention" as const],
          notifyChannels: ["event" as const, "async" as const],
        },
      },
    };
    const result = buildPausedRunnerTelemetry({
      config,
      plan: terminalPlan,
      results: [],
      controlConfig: controls,
      overallStartTime: 100,
      endedAt: 200,
      statusSteps: [],
    });
    assert.ok(result, "paused telemetry must be produced when provenance is present");
    assert.equal(
      result.run.execution,
      "async",
      "first committed paused status of an async run must carry execution='async'",
    );
    assert.equal(result.outcome?.state, "paused");
  });
});
