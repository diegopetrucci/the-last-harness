import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  ASYNC_DIR,
  type AcceptanceLedger,
  type AgentProgress,
  type CompactionReason,
  type DurableAttentionReason,
  type SingleResult,
} from "../../src/shared/types.ts";
import { readStatus } from "../../src/shared/utils.ts";
import {
  buildCohortPauseStep,
  buildPausedStepFromResult,
  persistPausedForegroundCohortRun,
  persistPausedForegroundSingleRun,
} from "../../src/runs/foreground/foreground-pause-state.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import {
  lifecycleGeneration,
  transitionLifecycleStatus,
  withLifecycleContinuation,
} from "../../src/runs/shared/lifecycle-state.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const acceptance = {
  status: "skipped",
  explicit: false,
  effectiveAcceptance: {
    level: "checked",
    explicit: false,
    inferredReason: [],
    criteria: [],
    evidence: [],
    verify: [],
    stopRules: [],
  },
  inferredReason: [],
  criteria: [],
  runtimeChecks: [],
  verifyRuns: [],
} satisfies AcceptanceLedger;

type RawStatusStep = {
  status?: string;
  agent?: string;
  sessionFile?: string;
  model?: string;
  activityState?: string;
  idleEpisodeId?: string;
  durableAttentionReasons?: string[];
  compaction?: { reason: string };
};

type RawLifecycleContinuation = {
  phase?: string;
  continuationRunId?: string;
};

type RawStatus = {
  state?: string;
  steps?: RawStatusStep[];
  lifecycle?: { continuation?: RawLifecycleContinuation };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label);
  if (result === undefined) throw new Error(`${label} is required.`);
  return result;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function optionalCompaction(value: unknown, label: string): { reason: string } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return { reason: requiredString(value.reason, `${label}.reason`) };
}

function parseRawStatus(value: unknown): RawStatus {
  if (!isRecord(value)) throw new Error("status.json must contain an object.");
  const rawSteps = value.steps;
  const steps =
    rawSteps === undefined
      ? undefined
      : Array.isArray(rawSteps)
        ? rawSteps.map((rawStep, index): RawStatusStep => {
            if (!isRecord(rawStep)) throw new Error(`steps[${index}] must be an object.`);
            return {
              status: optionalString(rawStep.status, `steps[${index}].status`),
              agent: optionalString(rawStep.agent, `steps[${index}].agent`),
              sessionFile: optionalString(rawStep.sessionFile, `steps[${index}].sessionFile`),
              model: optionalString(rawStep.model, `steps[${index}].model`),
              activityState: optionalString(rawStep.activityState, `steps[${index}].activityState`),
              idleEpisodeId: optionalString(rawStep.idleEpisodeId, `steps[${index}].idleEpisodeId`),
              durableAttentionReasons: optionalStringArray(
                rawStep.durableAttentionReasons,
                `steps[${index}].durableAttentionReasons`,
              ),
              compaction: optionalCompaction(rawStep.compaction, `steps[${index}].compaction`),
            };
          })
        : (() => {
            throw new Error("status.steps must be an array.");
          })();
  const rawLifecycle = value.lifecycle;
  if (rawLifecycle !== undefined && !isRecord(rawLifecycle))
    throw new Error("status.lifecycle must be an object.");
  const rawContinuation = isRecord(rawLifecycle) ? rawLifecycle.continuation : undefined;
  if (rawContinuation !== undefined && !isRecord(rawContinuation))
    throw new Error("status.lifecycle.continuation must be an object.");
  return {
    state: optionalString(value.state, "status.state"),
    steps,
    lifecycle:
      rawLifecycle === undefined
        ? undefined
        : {
            continuation:
              rawContinuation === undefined
                ? undefined
                : {
                    phase: optionalString(rawContinuation.phase, "continuation.phase"),
                    continuationRunId: optionalString(
                      rawContinuation.continuationRunId,
                      "continuation.continuationRunId",
                    ),
                  },
          },
  };
}

function makeProgress(
  agent: string,
  index: number,
  health: {
    activityState?: AgentProgress["activityState"];
    idleEpisodeId?: string;
    durableAttentionReasons?: DurableAttentionReason[];
    compaction?: AgentProgress["compaction"];
  },
  status: AgentProgress["status"] = "running",
): AgentProgress {
  return {
    index,
    agent,
    status,
    task: `task-${agent}`,
    recentTools: [],
    recentOutput: [],
    toolCount: 1,
    tokens: 1,
    durationMs: 100,
    ...health,
  };
}

function makeResult(
  agent: string,
  index: number,
  progress: AgentProgress,
  pause?: SingleResult["pause"],
  sessionFile = path.join(ASYNC_DIR, `${agent}.jsonl`),
): SingleResult {
  return {
    agent,
    task: `task-${agent}`,
    exitCode: 0,
    usage,
    progress,
    sessionFile,
    acceptance,
    ...(pause ? { pause } : {}),
    model: "test-model",
    thinking: "low",
    activeRuntimeMs: 100,
    activeRuntimeCheckpointAt: 1000 + index,
  };
}

function rawStatus(runId: string): RawStatus {
  const statusPath = path.join(ASYNC_DIR, runId, "status.json");
  const parsed: unknown = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  return parseRawStatus(parsed);
}

function reserveContinuation(runId: string, index = 0): void {
  const asyncDir = path.join(ASYNC_DIR, runId);
  const current = readStatus(asyncDir);
  assert.ok(current);
  transitionLifecycleStatus({
    asyncDir,
    expectedGeneration: lifecycleGeneration(current),
    mutate: (status) => ({
      ...status,
      lifecycle: withLifecycleContinuation(status, index, {
        phase: "reserved",
        claimToken: `claim-${runId}`,
        claimedAt: 20,
        ownerPid: 1234,
        continuationRunId: `continuation-${runId}`,
      }),
    }),
  });
}

function assertResumeHealth(runId: string, index: number, reasons: DurableAttentionReason[]): void {
  const target = resolveAsyncResumeTarget(
    { id: runId, index },
    {
      asyncDirRoot: ASYNC_DIR,
      resultsDir: path.join(path.dirname(ASYNC_DIR), "async-subagent-results"),
    },
    { readOnly: true },
  );
  assert.deepEqual(target.durableAttentionReasons, reasons);
  assert.equal(target.activityState, undefined);
  assert.equal(target.idleEpisodeId, undefined);
  assert.equal(target.compaction, undefined);
}

describe("foreground pause health persistence", () => {
  it("retains single-run durable reasons through pausing, finalization, status, and resume", () => {
    const runId = `foreground-single-health-${process.pid}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    try {
      const durableReasons: DurableAttentionReason[] = ["context_pressure"];
      const compaction: { reason: CompactionReason } = { reason: "threshold" };
      const pause = { kind: "awaiting_supervisor" as const, requestedAt: 10 };
      const progress = makeProgress("single", 0, {
        activityState: "needs_attention",
        idleEpisodeId: "single-episode",
        durableAttentionReasons: durableReasons,
        compaction,
      });
      const pausingResult = makeResult("single", 0, progress, pause);

      persistPausedForegroundSingleRun({
        runId,
        cwd: "/tmp/foreground-single",
        sessionId: "session-single",
        stage: "pausing",
        ownerPid: 4321,
        result: pausingResult,
      });
      const pausingRaw = rawStatus(runId);
      assert.deepEqual(pausingRaw.steps?.[0]?.durableAttentionReasons, ["context_pressure"]);
      assert.equal(pausingRaw.steps?.[0]?.activityState, "needs_attention");
      assert.equal(pausingRaw.steps?.[0]?.idleEpisodeId, "single-episode");
      assert.deepEqual(pausingRaw.steps?.[0]?.compaction, { reason: "threshold" });

      const projectedStep = buildPausedStepFromResult(pausingResult, 20, { stage: "pausing" });
      assert.notStrictEqual(projectedStep.durableAttentionReasons, durableReasons);
      assert.notStrictEqual(projectedStep.compaction, compaction);
      durableReasons.push("tool_failures");
      compaction.reason = "manual";
      assert.deepEqual(projectedStep.durableAttentionReasons, ["context_pressure"]);
      assert.deepEqual(projectedStep.compaction, { reason: "threshold" });

      reserveContinuation(runId);
      const finalProgress = makeProgress("single", 0, {
        durableAttentionReasons: ["context_pressure", "tool_failures"],
      });
      const finalSessionFile = path.join(asyncDir, "session-0.jsonl");
      const finalResult = makeResult(
        "single",
        0,
        finalProgress,
        { ...pause, pausedAt: 30 },
        finalSessionFile,
      );
      fs.writeFileSync(finalSessionFile, "", "utf8");
      persistPausedForegroundSingleRun({
        runId,
        cwd: "/tmp/foreground-single",
        sessionId: "session-single",
        stage: "paused",
        result: finalResult,
      });

      const finalRaw = rawStatus(runId);
      const step = finalRaw.steps?.[0];
      assert.deepEqual(step?.durableAttentionReasons, ["context_pressure", "tool_failures"]);
      assert.equal(step?.activityState, undefined);
      assert.equal(step?.idleEpisodeId, undefined);
      assert.equal(step?.compaction, undefined);
      assert.equal(finalRaw.lifecycle?.continuation?.phase, "reserved");
      assert.equal(finalRaw.lifecycle?.continuation?.continuationRunId, `continuation-${runId}`);

      const status = inspectSubagentStatus(
        { action: "status", id: runId },
        {
          asyncDirRoot: ASYNC_DIR,
          resultsDir: path.join(path.dirname(ASYNC_DIR), "async-subagent-results"),
          kill: () => false,
        },
      );
      assert.equal(status.isError, undefined);
      const statusText = status.content[0]?.type === "text" ? status.content[0].text : "";
      assert.match(statusText, /State: paused/);
      assert.doesNotMatch(statusText, /needs attention|active long-running/i);

      assertResumeHealth(runId, 0, ["context_pressure", "tool_failures"]);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });

  it("preserves completed sibling health and continuation metadata through full final results", () => {
    const runId = `foreground-cohort-health-${process.pid}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    try {
      const requesterReasons: DurableAttentionReason[] = ["context_pressure"];
      const requesterCompaction: { reason: CompactionReason } = { reason: "threshold" };
      const requesterPause = { kind: "awaiting_supervisor" as const, requestedAt: 11 };
      const requesterStep = buildCohortPauseStep({
        agent: "requester",
        sessionFile: path.join(asyncDir, "requester.jsonl"),
        status: "pausing",
        now: 11,
        durableAttentionReasons: requesterReasons,
        activityState: "needs_attention",
        idleEpisodeId: "requester-episode",
        compaction: requesterCompaction,
      });
      assert.notStrictEqual(requesterStep.durableAttentionReasons, requesterReasons);
      assert.notStrictEqual(requesterStep.compaction, requesterCompaction);
      requesterReasons.push("tool_failures");
      requesterCompaction.reason = "manual";
      assert.deepEqual(requesterStep.durableAttentionReasons, ["context_pressure"]);
      assert.deepEqual(requesterStep.compaction, { reason: "threshold" });

      const completedSiblingProgress = makeProgress(
        "completed",
        1,
        {
          activityState: "active_long_running",
          idleEpisodeId: "completed-episode",
          durableAttentionReasons: ["completion_guard"],
          compaction: { reason: "manual" },
        },
        "completed",
      );
      const completedSiblingResult = makeResult(
        "completed",
        1,
        completedSiblingProgress,
        undefined,
        path.join(asyncDir, "completed.jsonl"),
      );
      const completedSibling = buildPausedStepFromResult(completedSiblingResult, 9, {
        stage: "paused",
      });
      persistPausedForegroundCohortRun({
        runId,
        cwd: "/tmp/foreground-cohort",
        sessionId: "session-cohort",
        mode: "parallel",
        stage: "pausing",
        pause: requesterPause,
        steps: [requesterStep, completedSibling],
      });
      const checkpointRaw = rawStatus(runId);
      assert.deepEqual(checkpointRaw.steps?.[0]?.durableAttentionReasons, ["context_pressure"]);
      assert.equal(checkpointRaw.steps?.[0]?.activityState, "needs_attention");
      assert.deepEqual(checkpointRaw.steps?.[1]?.durableAttentionReasons, ["completion_guard"]);
      assert.equal(checkpointRaw.steps?.[1]?.activityState, "active_long_running");
      assert.equal(checkpointRaw.steps?.[1]?.idleEpisodeId, "completed-episode");
      assert.deepEqual(checkpointRaw.steps?.[1]?.compaction, { reason: "manual" });

      reserveContinuation(runId);
      const finalRequesterSessionFile = path.join(asyncDir, "requester-final.jsonl");
      const finalCompletedSiblingSessionFile = path.join(asyncDir, "completed-final.jsonl");
      const finalRequester = makeResult(
        "requester",
        0,
        makeProgress("requester", 0, {
          durableAttentionReasons: ["context_pressure", "tool_failures"],
        }),
        { ...requesterPause, pausedAt: 31 },
        finalRequesterSessionFile,
      );
      const finalCompletedSibling = makeResult(
        "completed",
        1,
        completedSiblingProgress,
        undefined,
        finalCompletedSiblingSessionFile,
      );
      fs.writeFileSync(finalRequesterSessionFile, "", "utf8");
      fs.writeFileSync(finalCompletedSiblingSessionFile, "", "utf8");
      persistPausedForegroundCohortRun({
        runId,
        cwd: "/tmp/foreground-cohort",
        sessionId: "session-cohort",
        mode: "parallel",
        stage: "paused",
        results: [finalRequester, finalCompletedSibling],
        pause: finalRequester.pause,
      });

      const finalRaw = rawStatus(runId);
      assert.equal(finalRaw.steps?.length, 2);
      assert.deepEqual(finalRaw.steps?.[0]?.durableAttentionReasons, [
        "context_pressure",
        "tool_failures",
      ]);
      assert.equal(finalRaw.steps?.[0]?.activityState, undefined);
      assert.equal(finalRaw.steps?.[0]?.idleEpisodeId, undefined);
      assert.equal(finalRaw.steps?.[0]?.compaction, undefined);
      assert.equal(finalRaw.steps?.[1]?.status, "completed");
      assert.equal(finalRaw.steps?.[1]?.agent, "completed");
      assert.equal(finalRaw.steps?.[1]?.activityState, "active_long_running");
      assert.equal(finalRaw.steps?.[1]?.idleEpisodeId, "completed-episode");
      assert.deepEqual(finalRaw.steps?.[1]?.durableAttentionReasons, ["completion_guard"]);
      assert.deepEqual(finalRaw.steps?.[1]?.compaction, { reason: "manual" });
      assert.equal(finalRaw.lifecycle?.continuation?.phase, "reserved");
      assert.equal(finalRaw.lifecycle?.continuation?.continuationRunId, `continuation-${runId}`);

      assertResumeHealth(runId, 0, ["context_pressure", "tool_failures"]);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });
});
