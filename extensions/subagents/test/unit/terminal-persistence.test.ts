import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildSubagentRunTelemetry,
  type SubagentRunTelemetry,
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
import { createNestedRoute } from "../../src/runs/shared/nested-events.ts";
import { writeNormalizedLifecycleStatus } from "../../src/runs/shared/lifecycle-state.ts";
import type {
  ResolvedControlConfig,
  CostSummary,
  TokenUsage,
  AsyncStatus,
} from "../../src/shared/types.ts";

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
const nestedRouteRoots: string[] = [];

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

function nestedEventTypes(eventSink: string): string[] {
  return fs
    .readdirSync(eventSink)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const event = JSON.parse(fs.readFileSync(path.join(eventSink, name), "utf8")) as {
        type?: string;
      };
      return event.type ?? "";
    });
}

function createNestedTerminalFixture(telemetry?: SubagentRunTelemetry): {
  owner: ReturnType<typeof createBackgroundRunStatusOwner>;
  route: ReturnType<typeof createNestedRoute>;
  asyncDir: string;
  resultPath: string;
  plan: typeof terminalPlan;
  telemetry?: SubagentRunTelemetry;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-nested-terminal-persistence-"));
  tempDirs.push(root);
  const route = createNestedRoute("nested-terminal-parent");
  nestedRouteRoots.push(path.dirname(route.eventSink));
  const asyncDir = path.join(root, "async");
  const resultPath = path.join(root, "result.json");
  const owner = createBackgroundRunStatusOwner({
    id: "nested-terminal-child",
    asyncDir,
    cwd: root,
    plan: terminalPlan,
    overallStartTime: 100,
    shareEnabled: false,
    artifactConfig: terminalArtifactConfig,
    ...(telemetry ? { telemetry } : {}),
    nestedRoute: route,
    nestedSelf: {
      parentRunId: route.rootRunId,
      parentStepIndex: 0,
      depth: 1,
      path: [{ runId: route.rootRunId, stepIndex: 0 }],
    },
    appendEvent: () => undefined,
  });
  return { owner, route, asyncDir, resultPath, plan: terminalPlan, telemetry };
}

function markNestedTerminalFixturePaused(
  fixture: ReturnType<typeof createNestedTerminalFixture>,
): AsyncStatus["pause"] {
  const pause: AsyncStatus["pause"] = {
    kind: "awaiting_supervisor",
    summary: "waiting for supervisor",
    requestedAt: 110,
    pausedAt: 120,
    ownerPid: undefined,
  };
  const { owner, asyncDir } = fixture;
  owner.interrupted = true;
  owner.statusPayload.state = "paused";
  owner.statusPayload.pid = undefined;
  owner.statusPayload.pause = pause;
  owner.statusPayload.endedAt = 120;
  owner.statusPayload.lastUpdate = 120;
  owner.statusPayload.steps = owner.statusPayload.steps.map((step) => ({
    ...step,
    status: "paused",
    endedAt: 120,
    pause,
  }));
  writeNormalizedLifecycleStatus(asyncDir, owner.statusPayload);
  return pause;
}

function persistNestedTerminalFixture(
  fixture: ReturnType<typeof createNestedTerminalFixture>,
  options: {
    pausedAwaitingSupervisor?: AsyncStatus["pause"];
  } = {},
): void {
  const { owner, asyncDir, resultPath, plan } = fixture;
  const statusPayload = owner.statusPayload;
  const result: RunnerStepResult = {
    agent: "worker",
    output: "child output",
    success: true,
    exitCode: 0,
  };
  persistRunnerTerminalRun({
    config: {
      id: statusPayload.runId,
      ...(fixture.telemetry ? { telemetry: fixture.telemetry } : {}),
      plan,
      resultPath,
      cwd: statusPayload.cwd,
      artifactConfig: terminalArtifactConfig,
      asyncDir,
    },
    plan,
    statusOwner: owner,
    statusPayload,
    results: [result],
    controlConfig: controls,
    overallStartTime: 100,
    runEndedAt: 125,
    summary: "terminal summary",
    truncated: false,
    agentName: "worker",
    resultPath,
    cwd: statusPayload.cwd,
    asyncDir,
    ...(options.pausedAwaitingSupervisor
      ? { pausedAwaitingSupervisor: options.pausedAwaitingSupervisor }
      : {}),
    skipFinalStatusWrite: false,
    pausedOutputForIndex: () => "paused source output",
    appendEvent: () => undefined,
    writeRunLog: () => undefined,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const dir of nestedRouteRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
        emitNestedSelfEvent: () => undefined,
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

  it("emits nested completion exactly once without telemetry on supervisor pause", () => {
    const fixture = createNestedTerminalFixture();
    const pause = markNestedTerminalFixturePaused(fixture);

    persistNestedTerminalFixture(fixture, { pausedAwaitingSupervisor: pause });

    assert.deepEqual(nestedEventTypes(fixture.route.eventSink), ["subagent.nested.completed"]);
    const artifact = JSON.parse(fs.readFileSync(fixture.resultPath, "utf8")) as {
      state: string;
      telemetry?: unknown;
    };
    assert.equal(artifact.state, "paused");
    assert.equal(artifact.telemetry, undefined);
  });

  it("does not duplicate nested completion when telemetry-enabled pause persistence writes status", () => {
    const telemetry = buildSubagentRunTelemetry({
      runId: "nested-terminal-child",
      execution: "async",
      mode: "single",
      provenance,
      controls,
      startedAt: 100,
      outcome: { state: "running" },
      steps: [{ index: 0, agent: "worker", outcome: { state: "queued" } }],
    });
    const fixture = createNestedTerminalFixture(telemetry);
    const pause = markNestedTerminalFixturePaused(fixture);

    persistNestedTerminalFixture(fixture, { pausedAwaitingSupervisor: pause });

    assert.deepEqual(nestedEventTypes(fixture.route.eventSink), ["subagent.nested.completed"]);
    const artifact = JSON.parse(fs.readFileSync(fixture.resultPath, "utf8")) as {
      telemetry?: unknown;
    };
    assert.ok(artifact.telemetry);
  });

  it("emits nested completion once after concurrent terminal adoption", () => {
    const fixture = createNestedTerminalFixture();
    const { owner, asyncDir } = fixture;
    const canonicalStatus: RunnerStatusPayload = {
      ...owner.statusPayload,
      state: "continued",
      pid: undefined,
      pause: undefined,
      endedAt: 200,
      lastUpdate: 200,
      steps: owner.statusPayload.steps.map((step) => ({
        ...step,
        status: "continued",
        endedAt: 200,
        pause: undefined,
      })),
    };
    writeNormalizedLifecycleStatus(asyncDir, canonicalStatus);

    assert.equal(owner.adoptConcurrentTerminalStatus()?.state, "continued");
    persistNestedTerminalFixture(fixture);
    owner.emitNestedSelfEvent("subagent.nested.completed");

    assert.deepEqual(nestedEventTypes(fixture.route.eventSink), ["subagent.nested.completed"]);
    const artifact = JSON.parse(fs.readFileSync(fixture.resultPath, "utf8")) as {
      state: string;
    };
    assert.equal(artifact.state, "continued");
  });
});
