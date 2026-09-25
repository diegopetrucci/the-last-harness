import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createBackgroundRunControlOwner } from "../../src/runs/background/run-control-owner.ts";
import { createBackgroundRunStatusOwner } from "../../src/runs/background/run-status-owner.ts";
import type { ChildEvent } from "../../src/runs/background/pi-streaming.ts";
import type { ResolvedControlConfig } from "../../src/shared/types.ts";

type StatusOwner = Parameters<typeof createBackgroundRunControlOwner>[0]["status"];
type StatusPayload = StatusOwner["statusPayload"];

function messageEnd(totalTokens: number): ChildEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "mock-api",
      provider: "mock",
      model: "test-model",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

function cloneStepObjects(payload: StatusPayload): void {
  payload.steps = payload.steps.map((step) => ({ ...step }));
}

function makeOwner(options: { enabled: boolean } = { enabled: true }): {
  owner: ReturnType<typeof createBackgroundRunControlOwner>;
  payload: StatusPayload;
  events: Array<Record<string, unknown>>;
  asyncDir: string;
  flatStep: StatusOwner["flatSteps"][number];
} {
  const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-run-control-owner-"));
  const payload: StatusPayload = {
    runId: "run-control-test",
    mode: "single",
    state: "running",
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    lastUpdate: Date.now(),
    cwd: process.cwd(),
    currentStep: 0,
    steps: [
      {
        agent: "worker",
        status: "running",
        startedAt: Date.now(),
        recentTools: [],
        recentOutput: [],
      },
    ],
  };
  const flatSteps: StatusOwner["flatSteps"] = [
    {
      agent: "worker",
      task: "test task",
      contextWindows: { "mock/test-model": 1_000 },
      inheritProjectContext: false,
      inheritSkills: false,
    },
  ];
  const status: StatusOwner = {
    flatSteps,
    sessionEnabled: false,
    statusPayload: payload,
    terminalReason: {},
    latestSessionFile: undefined,
    interrupted: false,
    cancelled: false,
    timedOut: false,
    supervisorPauseRequest: undefined,
    supervisorPauseTransitionFailed: false,
    durablePausingCheckpointPersisted: false,
    concurrentTerminalStatusAdopted: false,
    setControlHooks() {},
    beginTrackedSessionStep() {},
    refreshTrackedSessionFile() {
      return undefined;
    },
    writeStatusPayload() {
      payload.activityState = payload.steps.some((step) => step.activityState === "needs_attention")
        ? "needs_attention"
        : undefined;
      cloneStepObjects(payload);
    },
    recordAttemptFacts() {},
    onChildProtocolOutputLimit() {},
    pausedStepResult() {
      throw new Error("not used in run-control projection tests");
    },
    timedOutStepResult() {
      throw new Error("not used in run-control projection tests");
    },
    pauseMetadataForIndex() {
      return undefined;
    },
    adoptConcurrentTerminalStatus() {
      return undefined;
    },
    requestSupervisorPause() {
      cloneStepObjects(payload);
    },
    cancel() {},
    interrupt() {},
    timeout() {},
    ownedPauseProcessesConfirmedStopped() {
      return true;
    },
    isPersistedAwaitingSupervisorPause() {
      return false;
    },
    applyPausedStepMetadata() {},
    emitNestedSelfEvent() {},
    startHeartbeat() {},
    stopHeartbeat() {},
  };
  const events: Array<Record<string, unknown>> = [];
  const controlConfig: ResolvedControlConfig = {
    enabled: options.enabled,
    needsAttentionAfterMs: 1,
    notifyOn: ["needs_attention"],
    notifyChannels: ["event"],
  };
  const owner = createBackgroundRunControlOwner({
    status,
    id: payload.runId,
    asyncDir,
    overallStartTime: payload.startedAt,
    controlConfig,
    appendEvent(line) {
      events.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { owner, payload, events, asyncDir, flatStep: flatSteps[0]! };
}

function makeProductionOwner(): {
  owner: ReturnType<typeof createBackgroundRunControlOwner>;
  status: ReturnType<typeof createBackgroundRunStatusOwner>;
  asyncDir: string;
} {
  const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-run-control-production-"));
  const startedAt = Date.now();
  const status = createBackgroundRunStatusOwner({
    id: "run-control-production",
    asyncDir,
    cwd: process.cwd(),
    plan: {
      kind: "single",
      task: {
        agent: "worker",
        task: "production run-control test",
        model: "mock/test-model",
        contextWindows: { "mock/test-model": 1_000 },
        inheritProjectContext: false,
        inheritSkills: false,
      },
    },
    overallStartTime: startedAt,
    shareEnabled: false,
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
    appendEvent() {},
  });
  const step = status.statusPayload.steps[0]!;
  step.status = "running";
  step.startedAt = startedAt;
  step.lastActivityAt = startedAt;
  status.writeStatusPayload();
  const owner = createBackgroundRunControlOwner({
    status,
    id: status.statusPayload.runId,
    asyncDir,
    overallStartTime: startedAt,
    controlConfig: {
      enabled: true,
      needsAttentionAfterMs: 180_000,
      notifyOn: ["needs_attention"],
      notifyChannels: ["event"],
    },
    appendEvent() {},
  });
  return { owner, status, asyncDir };
}

function cleanup(asyncDir: string): void {
  fs.rmSync(asyncDir, { recursive: true, force: true });
}

describe("background run-control child-event projection", () => {
  it("persists pressure without idle attention when controls are disabled", () => {
    const test = makeOwner({ enabled: false });
    try {
      test.owner.updateStepFromChildEvent(0, messageEnd(850));
      const step = test.payload.steps[0]!;
      assert.equal(step.contextPressure?.severity, "warning");
      assert.deepEqual(step.contextPressureCrossedThresholds, ["warning"]);
      assert.equal(step.activityState, undefined);
      assert.equal(step.idleEpisodeId, undefined);
      assert.equal(test.payload.activityState, undefined);
      assert.deepEqual(test.flatStep.contextPressureCrossedThresholds, ["warning"]);
      assert.equal(test.flatStep.contextPressure?.severity, "warning");
      assert.deepEqual(test.events, []);
    } finally {
      cleanup(test.asyncDir);
    }
  });

  it("leaves pressure out of idle attention and rearms a later genuine idle episode", async () => {
    const test = makeOwner();
    try {
      test.owner.updateStepFromChildEvent(0, messageEnd(850));
      let step = test.payload.steps[0]!;
      assert.equal(step.activityState, undefined);
      assert.equal(step.idleEpisodeId, undefined);
      assert.deepEqual(test.flatStep.contextPressureCrossedThresholds, ["warning"]);
      assert.equal(test.flatStep.contextPressure?.severity, "warning");
      assert.equal(test.events.length, 1);
      assert.equal(
        test.events[0]?.event && (test.events[0].event as Record<string, unknown>).reason,
        "context_pressure",
      );

      let tick: (() => void) | undefined;
      const originalSetInterval = globalThis.setInterval;
      const fakeTimer = { unref() {} } as ReturnType<typeof setInterval>;
      globalThis.setInterval = ((callback: () => void) => {
        tick = callback;
        return fakeTimer;
      }) as typeof setInterval;
      try {
        test.owner.startActivityTimer();
      } finally {
        globalThis.setInterval = originalSetInterval;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      tick?.();

      step = test.payload.steps[0]!;
      assert.equal(step.activityState, "needs_attention");
      assert.ok(step.idleEpisodeId);
      assert.equal(test.events.length, 2);
      const idleEvent = test.events[1]?.event as Record<string, unknown> | undefined;
      assert.equal(idleEvent?.reason, "idle");
      assert.equal(idleEvent?.idleEpisodeId, step.idleEpisodeId);
      test.owner.disposeActivityTimer();
    } finally {
      cleanup(test.asyncDir);
    }
  });

  it("persists both pressure crossings, final critical projection, and child/root tokens before notifying", () => {
    const test = makeOwner();
    try {
      test.owner.updateStepFromChildEvent(0, messageEnd(950));
      const step = test.payload.steps[0]!;
      assert.deepEqual(step.contextPressureCrossedThresholds, ["warning", "critical"]);
      assert.equal(step.contextPressure?.severity, "critical");
      assert.deepEqual(step.tokens, { input: 100, output: 20, total: 120 });
      assert.deepEqual(test.payload.totalTokens, { input: 100, output: 20, total: 120 });
      assert.equal(step.activityState, undefined);
      assert.equal(step.idleEpisodeId, undefined);
      assert.deepEqual(test.flatStep.contextPressureCrossedThresholds, ["warning", "critical"]);
      assert.equal(test.flatStep.contextPressure?.severity, "critical");
      assert.notEqual(test.flatStep.contextPressure, step.contextPressure);
      assert.notEqual(
        test.flatStep.contextPressureCrossedThresholds,
        step.contextPressureCrossedThresholds,
      );
      assert.deepEqual(
        test.events.map((entry) => {
          const event = entry.event as Record<string, unknown>;
          return {
            reason: event.reason,
            threshold: event.contextPressureThreshold,
            tokens: event.tokens,
          };
        }),
        [
          { reason: "context_pressure", threshold: "warning", tokens: 120 },
          { reason: "context_pressure", threshold: "critical", tokens: 120 },
        ],
      );
    } finally {
      cleanup(test.asyncDir);
    }
  });

  it("re-reads a step after a pause status merge before applying the child event", () => {
    const test = makeOwner();
    try {
      test.owner.updateStepFromChildEvent(0, {
        type: "tool_execution_start",
        toolName: "contact_supervisor",
        args: { reason: "need_decision", message: "Need a decision" },
      });
      const step = test.payload.steps[0]!;
      assert.equal(step.toolCount, 1);
      assert.equal(step.currentTool, "contact_supervisor");
      assert.equal(test.payload.toolCount, 1);
    } finally {
      cleanup(test.asyncDir);
    }
  });

  it("applies supervisor-pause child fields through the real status-owner replacement", () => {
    const test = makeProductionOwner();
    try {
      test.owner.updateStepFromChildEvent(0, {
        type: "tool_execution_start",
        toolName: "contact_supervisor",
        args: { reason: "need_decision", message: "Need a decision" },
      });
      const persisted = JSON.parse(
        fs.readFileSync(path.join(test.asyncDir, "status.json"), "utf-8"),
      ) as StatusPayload & { state: string };
      const step = persisted.steps[0]!;
      assert.equal(persisted.state, "pausing");
      assert.equal(step.status, "pausing");
      assert.equal(step.toolCount, 1);
      assert.equal(step.currentTool, "contact_supervisor");
      assert.equal(test.status.statusPayload.steps[0]?.currentTool, "contact_supervisor");
    } finally {
      cleanup(test.asyncDir);
    }
  });
});
