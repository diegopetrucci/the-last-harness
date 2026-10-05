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
  persistRunnerTerminalRun,
  type RunnerStepResult,
} from "../../src/runs/background/terminal-persistence.ts";
import {
  createBackgroundRunStatusOwner,
  type RunnerStatusPayload,
} from "../../src/runs/background/run-status-owner.ts";
import { writeNormalizedLifecycleStatus } from "../../src/runs/shared/lifecycle-state.ts";
import type { ResolvedControlConfig, CostSummary, TokenUsage } from "../../src/shared/types.ts";

const controls: ResolvedControlConfig = {
  enabled: true,
  needsAttentionAfterMs: 2_000,
  failedToolAttemptsBeforeAttention: 3,
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
      assert.equal(persisted.state, adoptedState);
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
    assert.deepEqual(
      artifact.results.map((result) => result.error),
      [ordinaryError, timeoutError],
    );
    assert.deepEqual(artifact.telemetry?.outcome, {
      state: "failed",
      terminationReason: "timed_out",
    });
  });
});
