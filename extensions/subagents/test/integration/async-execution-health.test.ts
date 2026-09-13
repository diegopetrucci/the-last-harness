/** Integration tests for background health transitions and cleanup. */

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
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import {
  lifecycleGeneration,
  transitionLifecycleStatus,
  withLifecycleContinuation,
} from "../../src/runs/shared/lifecycle-state.ts";
import { ACTIVITY_MONITOR_INTERVAL_MS } from "../../src/runs/shared/health-transition.ts";
import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  executeAsyncParallel,
  executeAsyncSingle,
  requestAsyncInterrupt,
  waitForAsyncControlCondition,
  waitForAsyncResultFile,
  waitForAsyncStatusPredicate,
  waitForMarker,
} from "../support/async-execution-helpers.ts";

describe("async execution health", () => {
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

  it("background idle episodes recover only on validated activity and dedupe raw-noise freshness", async () => {
    const markerDir = path.join(tempDir, "async-idle-recovery-markers");
    fs.mkdirSync(markerDir, { recursive: true });
    const firstIdleRelease = path.join(markerDir, "first-idle-release");
    const rawDone = path.join(markerDir, "raw-done");
    const validatedRelease = path.join(markerDir, "validated-release");
    const secondIdleRelease = path.join(markerDir, "second-idle-release");
    mockPi.onCall({
      steps: [
        { jsonl: [events.assistantMessage("initial progress", "mock/test-model", "tool_use")] },
        { waitForMarker: firstIdleRelease },
        { stderr: "raw diagnostic noise\\n", writeMarkerAfter: rawDone },
        { waitForMarker: validatedRelease },
        { jsonl: [events.assistantMessage("validated progress", "mock/test-model", "tool_use")] },
        { waitForMarker: secondIdleRelease },
        { jsonl: [events.assistantMessage("final progress")] },
      ],
    });

    const id = `async-idle-recovery-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "scout",
      task: "Investigate behavior",
      agentConfig: makeAgent("scout"),
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-idle-recovery",
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
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
      controlConfig: {
        enabled: true,
        needsAttentionAfterMs: 200,
        failedToolAttemptsBeforeAttention: 3,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      },
    });

    const firstObserved = await waitForAsyncControlCondition(asyncDir, (status, eventText) => {
      const controls = eventText
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === "subagent.control" && record.event?.reason === "idle");
      return (
        controls.length === 1 &&
        status.activityState === "needs_attention" &&
        status.steps?.[0]?.activityState === "needs_attention" &&
        typeof status.steps?.[0]?.idleEpisodeId === "string"
      );
    });
    const firstIdleControl = firstObserved.eventText
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((record) => record.type === "subagent.control" && record.event?.reason === "idle");
    const firstIdleTs = firstIdleControl?.event?.ts as number;
    const firstEpisodeId = firstObserved.status.steps?.[0]?.idleEpisodeId;
    assert.equal(typeof firstEpisodeId, "string");
    assert.equal(firstIdleControl?.event?.idleEpisodeId, firstEpisodeId);
    fs.writeFileSync(firstIdleRelease, "", "utf-8");

    await waitForMarker(rawDone);
    const rawObserved = await waitForAsyncControlCondition(asyncDir, (status, eventText) => {
      const controls = eventText
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === "subagent.control" && record.event?.reason === "idle");
      return (
        controls.length === 1 &&
        status.steps?.[0]?.idleEpisodeId === firstEpisodeId &&
        status.steps?.[0]?.activityState === "needs_attention" &&
        (status.steps?.[0]?.lastActivityAt ?? 0) > firstIdleTs
      );
    });
    assert.equal(rawObserved.status.activityState, "needs_attention");
    assert.equal(rawObserved.status.steps?.[0]?.idleEpisodeId, firstEpisodeId);
    fs.writeFileSync(validatedRelease, "", "utf-8");

    const secondObserved = await waitForAsyncControlCondition(asyncDir, (status, eventText) => {
      const controls = eventText
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === "subagent.control" && record.event?.reason === "idle");
      return (
        controls.length === 2 &&
        status.activityState === "needs_attention" &&
        status.steps?.[0]?.activityState === "needs_attention" &&
        typeof status.steps?.[0]?.idleEpisodeId === "string" &&
        status.steps?.[0]?.idleEpisodeId !== firstEpisodeId
      );
    });
    const secondEpisodeId = secondObserved.status.steps?.[0]?.idleEpisodeId;
    assert.equal(typeof secondEpisodeId, "string");
    assert.notEqual(secondEpisodeId, firstEpisodeId);
    fs.writeFileSync(secondIdleRelease, "", "utf-8");

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const finalStatus = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    const controls = fs
      .readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.type === "subagent.control" && record.event?.reason === "idle");
    assert.equal(payload.state, "complete");
    assert.equal(payload.success, true);
    assert.equal(controls.length, 2);
    assert.notEqual(controls[0]?.event?.idleEpisodeId, controls[1]?.event?.idleEpisodeId);
    assert.equal(finalStatus.activityState, undefined);
    assert.equal(finalStatus.steps?.[0]?.activityState, undefined);
    assert.equal(finalStatus.steps?.[0]?.idleEpisodeId, undefined);
  });

  it(
    "does not charge a delayed background monitor gap as idle time",
    { skip: process.platform === "win32" ? "SIGSTOP is unavailable on Windows" : undefined },
    async () => {
      const markerDir = path.join(tempDir, "async-monitor-gap-markers");
      fs.mkdirSync(markerDir, { recursive: true });
      const ready = path.join(markerDir, "ready");
      const release = path.join(markerDir, "release");
      mockPi.onCall({
        steps: [
          {
            jsonl: [events.assistantMessage("quiet baseline", "mock/test-model", "tool_use")],
            writeMarkerAfter: ready,
          },
          { waitForMarker: release },
          { jsonl: [events.assistantMessage("completed")] },
        ],
      });

      const id = `async-monitor-gap-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, id);
      executeAsyncSingle(id, {
        agent: "scout",
        task: "Investigate monitor timing",
        agentConfig: makeAgent("scout"),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: id },
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
        controlConfig: {
          enabled: true,
          needsAttentionAfterMs: 2_000,
          failedToolAttemptsBeforeAttention: 3,
          notifyOn: ["needs_attention"],
          notifyChannels: ["event", "async"],
        },
      });

      await waitForMarker(ready);
      const running = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) => status.state === "running" && typeof status.pid === "number",
        "running monitor-gap background run",
      );
      // Let one ordinary watchdog observation establish a baseline before
      // suspending the runner. The child remains quiet while only the monitor
      // is stopped, so the old wall-clock calculation emits immediately after
      // SIGCONT whereas the observation-aware baseline does not.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const runnerPid = running.pid;
      assert.ok(typeof runnerPid === "number");
      let resumed = false;
      try {
        process.kill(runnerPid, "SIGSTOP");
        await new Promise((resolve) => setTimeout(resolve, 3_200));
        process.kill(runnerPid, "SIGCONT");
        resumed = true;

        const afterGap = await waitForAsyncControlCondition(
          asyncDir,
          (_status, eventText) => {
            const records = eventText
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            const diagnostics = records.filter(
              (record) => record.type === "subagent.run.monitor_gap",
            );
            const idleControls = records.filter(
              (record) => record.type === "subagent.control" && record.event?.reason === "idle",
            );
            return diagnostics.length === 1 && idleControls.length === 0;
          },
          scaleTestTimeout(10_000),
        );
        const diagnostic = afterGap.eventText
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((record) => record.type === "subagent.run.monitor_gap");
        assert.deepEqual(Object.keys(diagnostic ?? {}).sort(), ["gapMs", "runId", "ts", "type"]);
        assert.ok(typeof diagnostic?.gapMs === "number" && diagnostic.gapMs >= 3_000);
        assert.doesNotMatch(
          JSON.stringify(diagnostic),
          /quiet baseline|Investigate monitor timing/,
        );

        const idleObserved = await waitForAsyncControlCondition(
          asyncDir,
          (_status, eventText) => {
            const records = eventText
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            return records.some(
              (record) => record.type === "subagent.control" && record.event?.reason === "idle",
            );
          },
          scaleTestTimeout(10_000),
        );
        const idleControl = idleObserved.eventText
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((record) => record.type === "subagent.control" && record.event?.reason === "idle");
        assert.ok(typeof idleControl?.event?.elapsedMs === "number");
        assert.ok(idleControl.event.elapsedMs >= 2_000);
        assert.ok(idleControl.event.elapsedMs <= 4_000);
        fs.writeFileSync(release, "", "utf-8");
      } finally {
        if (!resumed && typeof runnerPid === "number") {
          try {
            process.kill(runnerPid, "SIGCONT");
          } catch {
            // The runner may have already exited after a test failure.
          }
        }
        if (!fs.existsSync(release)) fs.writeFileSync(release, "", "utf-8");
      }

      await waitForAsyncResultFile(id);
    },
  );

  it("background compaction suppresses idle but preserves post-operation stall detection", async () => {
    for (const variant of [
      { name: "normal", reason: "manual" as const, options: {} },
      { name: "abort", reason: "threshold" as const, options: { aborted: true, willRetry: true } },
      {
        name: "failure",
        reason: "overflow" as const,
        options: { aborted: false, willRetry: false, errorMessage: "compaction failed" },
      },
    ]) {
      mockPi.reset();
      const markerDir = path.join(tempDir, `async-compaction-${variant.name}`);
      fs.mkdirSync(markerDir, { recursive: true });
      const started = path.join(markerDir, "started");
      const release = path.join(markerDir, "release");
      const idleRelease = path.join(markerDir, "idle-release");
      mockPi.onCall({
        steps: [
          { jsonl: [events.assistantMessage("before compaction", "mock/test-model", "tool_use")] },
          {
            jsonl: [events.compactionStart(variant.reason)],
            writeMarkerAfter: started,
          },
          { waitForMarker: release },
          { jsonl: [events.compactionEnd(variant.reason, variant.options)] },
          { waitForMarker: idleRelease },
          { jsonl: [events.assistantMessage("after compaction")] },
        ],
      });
      const id = `async-compaction-${variant.name}-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, id);
      executeAsyncSingle(id, {
        agent: "scout",
        task: "Investigate behavior",
        agentConfig: makeAgent("scout"),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: id },
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
        controlConfig: {
          enabled: true,
          needsAttentionAfterMs: 200,
          failedToolAttemptsBeforeAttention: 3,
          notifyOn: ["needs_attention"],
          notifyChannels: ["event", "async"],
        },
      });
      await waitForMarker(started);
      const compacting = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) => status.steps?.[0]?.compaction?.reason === variant.reason,
        `compaction ${variant.name}`,
      );
      assert.equal(compacting.activityState, undefined);
      const monitorOpportunityAt =
        Date.now() +
        Math.max(
          ACTIVITY_MONITOR_INTERVAL_MS * 2,
          scaleTestTimeout(ACTIVITY_MONITOR_INTERVAL_MS * 2),
        );
      const monitorObserved = await waitForAsyncControlCondition(asyncDir, (status, eventText) => {
        assert.doesNotMatch(eventText, /"reason":"idle"/);
        return (
          status.steps?.[0]?.compaction?.reason === variant.reason &&
          Date.now() >= monitorOpportunityAt
        );
      });
      assert.doesNotMatch(monitorObserved.eventText, /"reason":"idle"/);
      fs.writeFileSync(release, "", "utf-8");

      const idleObserved = await waitForAsyncControlCondition(asyncDir, (status, eventText) => {
        return (
          eventText.includes('"reason":"idle"') &&
          status.activityState === "needs_attention" &&
          status.steps?.[0]?.activityState === "needs_attention" &&
          status.steps?.[0]?.compaction === undefined
        );
      });
      assert.equal(idleObserved.status.steps?.[0]?.compaction, undefined);
      fs.writeFileSync(idleRelease, "", "utf-8");
      const resultPath = await waitForAsyncResultFile(id);
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const finalStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(payload.success, true);
      assert.equal(finalStatus.steps?.[0]?.compaction, undefined);
      assert.equal(finalStatus.steps?.[0]?.activityState, undefined);
    }
  });

  it("background cleans up compaction without an end event before fallback idle recovery", async () => {
    const markerDir = path.join(tempDir, "async-no-end-fallback-markers");
    fs.mkdirSync(markerDir, { recursive: true });
    const firstCompactionStarted = path.join(markerDir, "first-compaction-started");
    const firstRelease = path.join(markerDir, "first-release");
    const fallbackStarted = path.join(markerDir, "fallback-started");
    const fallbackIdleRelease = path.join(markerDir, "fallback-idle-release");
    mockPi.onCall({
      exitCode: 1,
      steps: [
        {
          jsonl: [events.compactionStart("manual")],
          writeMarkerAfter: firstCompactionStarted,
        },
        { waitForMarker: firstRelease },
        {
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "rate limit exceeded" }],
                model: "openai/gpt-5-mini",
                errorMessage: "rate limit exceeded",
                stopReason: "error",
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
              },
            },
          ],
        },
      ],
    });
    mockPi.onCall({
      steps: [
        {
          jsonl: [events.assistantMessage("fallback still working", "mock/test-model", "tool_use")],
          writeMarkerAfter: fallbackStarted,
        },
        { waitForMarker: fallbackIdleRelease },
        { jsonl: [events.assistantMessage("fallback completed")] },
      ],
    });
    const id = `async-no-end-fallback-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "scout",
      task: "Investigate behavior",
      agentConfig: makeAgent("scout", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4"],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: id },
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
      controlConfig: {
        enabled: true,
        needsAttentionAfterMs: 200,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      },
    });

    const activeObserved = await waitForAsyncStatusPredicate(
      asyncDir,
      (status) =>
        status.steps?.[0]?.compaction?.reason === "manual" &&
        status.steps?.[0]?.activityState === undefined &&
        status.steps?.[0]?.idleEpisodeId === undefined,
      "unpaired compaction before background fallback",
    );
    assert.equal(activeObserved.activityState, undefined);
    assert.doesNotMatch(
      fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"),
      /"reason":"idle"/,
    );
    fs.writeFileSync(firstRelease, "", "utf-8");

    await waitForMarker(fallbackStarted);
    const idleObserved = await waitForAsyncControlCondition(
      asyncDir,
      (status, eventText) => {
        const idleControls = eventText
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter(
            (record) => record.type === "subagent.control" && record.event?.reason === "idle",
          );
        return (
          idleControls.length === 1 &&
          status.activityState === "needs_attention" &&
          status.steps?.[0]?.activityState === "needs_attention" &&
          typeof status.steps?.[0]?.idleEpisodeId === "string" &&
          status.steps?.[0]?.compaction === undefined
        );
      },
      scaleTestTimeout(10_000),
    );
    const idleControls = idleObserved.eventText
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.type === "subagent.control" && record.event?.reason === "idle");
    assert.equal(idleControls.length, 1);
    assert.equal(
      idleControls[0]?.event?.idleEpisodeId,
      idleObserved.status.steps?.[0]?.idleEpisodeId,
    );
    fs.writeFileSync(fallbackIdleRelease, "", "utf-8");

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const finalStatus = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(payload.state, "complete");
    assert.equal(payload.success, true);
    assert.equal(payload.results?.[0]?.activityState, undefined);
    assert.equal(payload.results?.[0]?.idleEpisodeId, undefined);
    assert.equal(payload.results?.[0]?.compaction, undefined);
    assert.equal(payload.results?.[0]?.durableAttentionReasons, undefined);
    assert.equal(finalStatus.activityState, undefined);
    assert.equal(finalStatus.steps?.[0]?.activityState, undefined);
    assert.equal(finalStatus.steps?.[0]?.idleEpisodeId, undefined);
    assert.equal(finalStatus.steps?.[0]?.compaction, undefined);
    assert.equal(finalStatus.steps?.[0]?.durableAttentionReasons, undefined);
    const eventText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
    assert.doesNotMatch(eventText, /compaction_end/);
    const finalIdleControls = eventText
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.type === "subagent.control" && record.event?.reason === "idle");
    assert.equal(finalIdleControls.length, 1);
  });

  it(
    "keeps a competing continued lifecycle winner during no-end supervisor compaction cleanup",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const markerDir = path.join(tempDir, "async-no-end-supervisor-race-markers");
      fs.mkdirSync(markerDir, { recursive: true });
      const compactionStarted = path.join(markerDir, "compaction-started");
      const release = path.join(markerDir, "release");
      const pressureBeforeCompaction = {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "preserve progress before compaction" }],
          provider: "mock",
          model: "test-model",
          stopReason: "toolUse",
          usage: { totalTokens: 800, input: 700, output: 100, cacheRead: 0, cacheWrite: 0 },
        },
      };
      mockPi.onCall({
        ignoreSigint: true,
        ignoreSigterm: true,
        steps: [
          { jsonl: [pressureBeforeCompaction] },
          {
            jsonl: [events.compactionStart("threshold")],
            writeMarkerAfter: compactionStarted,
          },
          { waitForMarker: release },
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision after compaction",
              }),
            ],
          },
        ],
        keepAliveAfterFinalMessageMs: scaleTestTimeout(30_000),
      });

      const id = `async-no-end-supervisor-race-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, id);
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Ask for a supervisor decision after compaction.",
        agentConfig: makeAgent("worker", { model: "mock/test-model" }),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: id },
        availableModels: [
          { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
        ],
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

      await waitForMarker(compactionStarted);
      const compactionStatus = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) =>
          status.steps?.[0]?.durableAttentionReasons?.includes("context_pressure") === true &&
          status.steps?.[0]?.compaction?.reason === "threshold",
        "source-generated pressure and unpaired compaction before competing supervisor winner",
      );
      assert.deepEqual(compactionStatus.steps?.[0]?.durableAttentionReasons, ["context_pressure"]);
      assert.equal(compactionStatus.steps?.[0]?.contextPressure?.severity, "warning");
      assert.deepEqual(compactionStatus.steps?.[0]?.contextPressureCrossedThresholds, ["warning"]);
      const compactionGeneration = lifecycleGeneration(compactionStatus);
      const winnerAt = Date.now();
      const claimToken = "tlhf-uv2r-winner-claim";
      const continuationRunId = "tlhf-uv2r-winner-continuation";
      transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: compactionGeneration,
        mutate: (status) => ({
          ...status,
          state: "continued" as const,
          pid: undefined,
          pause: undefined,
          activityState: undefined,
          currentTool: undefined,
          currentToolStartedAt: undefined,
          currentPath: undefined,
          endedAt: winnerAt,
          lastUpdate: winnerAt,
          steps: status.steps?.map((step) => ({
            ...step,
            status: "continued" as const,
            endedAt: winnerAt,
            exitCode: 0,
            pause: undefined,
            activityState: undefined,
            idleEpisodeId: undefined,
            compaction: undefined,
            durableAttentionReasons: step.durableAttentionReasons,
          })),
          lifecycle: withLifecycleContinuation(status, 0, {
            phase: "continued" as const,
            claimToken,
            claimedAt: winnerAt - 1,
            continuedAt: winnerAt,
            continuationRunId,
          }),
        }),
      });

      const persistedWinner = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const winnerGeneration = lifecycleGeneration(persistedWinner);
      assert.equal(persistedWinner.state, "continued");
      assert.equal(persistedWinner.steps?.[0]?.status, "continued");
      assert.equal(persistedWinner.lifecycle?.continuation?.phase, "continued");
      assert.equal(persistedWinner.lifecycle?.continuation?.claimToken, claimToken);
      assert.equal(persistedWinner.lifecycle?.continuation?.continuationRunId, continuationRunId);
      assert.equal(winnerGeneration, compactionGeneration + 1);

      // The child now emits the supervisor request. The lifecycle winner is already
      // persisted, so cleanup must only change in-memory health until the locked
      // checkpoint/transition observes and adopts that winner.
      fs.writeFileSync(release, "", "utf-8");
      const resultPath = await waitForAsyncResultFile(id);
      const finalStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const resultPayload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

      assert.equal(
        finalStatus.state,
        "continued",
        "cleanup must not downgrade the winner to pausing",
      );
      assert.equal(lifecycleGeneration(finalStatus), winnerGeneration);
      assert.equal(finalStatus.steps?.[0]?.status, "continued");
      assert.equal(finalStatus.lifecycle?.continuation?.phase, "continued");
      assert.equal(finalStatus.lifecycle?.continuation?.claimToken, claimToken);
      assert.equal(finalStatus.lifecycle?.continuation?.continuationRunId, continuationRunId);
      assert.equal(finalStatus.pause, undefined);
      assert.equal(finalStatus.activityState, undefined);
      assert.equal(finalStatus.steps?.[0]?.activityState, undefined);
      assert.equal(finalStatus.steps?.[0]?.idleEpisodeId, undefined);
      assert.equal(finalStatus.steps?.[0]?.compaction, undefined);
      assert.deepEqual(finalStatus.steps?.[0]?.durableAttentionReasons, ["context_pressure"]);
      assert.deepEqual(resultPayload.results?.[0]?.durableAttentionReasons, ["context_pressure"]);
      assert.equal(resultPayload.state, "continued");
    },
  );

  it("clears background unpaired compaction during interrupt and timeout cleanup", async () => {
    for (const variant of ["interrupt", "timeout"] as const) {
      mockPi.reset();
      const markerDir = path.join(tempDir, `async-no-end-${variant}-markers`);
      fs.mkdirSync(markerDir, { recursive: true });
      const compactionStarted = path.join(markerDir, "compaction-started");
      const release = path.join(markerDir, "release");
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "near context limit" }],
                  provider: "mock",
                  model: "mock/test-model",
                  stopReason: "toolUse",
                  usage: {
                    totalTokens: 800,
                    input: 700,
                    output: 100,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              },
            ],
          },
          {
            jsonl: [events.compactionStart("threshold")],
            writeMarkerAfter: compactionStarted,
          },
          { waitForMarker: release },
        ],
      });
      const id = `async-no-end-${variant}-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, id);
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Implement the approved fixes",
        agentConfig: makeAgent("worker", { model: "mock/test-model" }),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: id },
        availableModels: [
          { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
        ],
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
        ...(variant === "timeout" ? { timeoutMs: scaleTestTimeout(3_000) } : {}),
        controlConfig: {
          enabled: true,
          needsAttentionAfterMs: 200,
          notifyOn: ["needs_attention"],
          notifyChannels: ["event", "async"],
        },
      });

      const activeObserved = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) =>
          status.steps?.[0]?.compaction?.reason === "threshold" &&
          status.steps?.[0]?.durableAttentionReasons?.includes("context_pressure") === true &&
          status.activityState === "needs_attention" &&
          status.steps?.[0]?.activityState === "needs_attention" &&
          status.steps?.[0]?.idleEpisodeId === undefined,
        `${variant} unpaired compaction before cleanup`,
      );
      assert.equal(activeObserved.activityState, "needs_attention");
      assert.equal(
        activeObserved.steps?.[0]?.durableAttentionReasons?.includes("context_pressure"),
        true,
      );
      if (variant === "interrupt") requestAsyncInterrupt(asyncDir);
      const cleanupObserved = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) =>
          status.activityState === undefined &&
          status.steps?.[0]?.activityState === undefined &&
          status.steps?.[0]?.idleEpisodeId === undefined &&
          status.steps?.[0]?.compaction === undefined &&
          status.steps?.[0]?.durableAttentionReasons?.includes("context_pressure") === true,
        `${variant} cleared unpaired compaction`,
      );
      assert.equal(cleanupObserved.steps?.[0]?.compaction, undefined);

      const resultPath = await waitForAsyncResultFile(id);
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const finalStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      if (variant === "interrupt") {
        assert.equal(payload.state, "paused");
        assert.equal(payload.results?.[0]?.interrupted, true);
        assert.equal(payload.results?.[0]?.terminationReason, "paused");
        assert.equal(finalStatus.state, "paused");
        assert.equal(finalStatus.steps?.[0]?.status, "paused");
      } else {
        assert.equal(payload.state, "failed");
        assert.equal(payload.results?.[0]?.timedOut, true);
        assert.equal(payload.results?.[0]?.terminationReason, "timed_out");
        assert.equal(finalStatus.state, "failed");
        assert.equal(finalStatus.steps?.[0]?.status, "failed");
      }
      assert.equal(payload.results?.[0]?.activityState, undefined);
      assert.equal(payload.results?.[0]?.idleEpisodeId, undefined);
      assert.equal(payload.results?.[0]?.compaction, undefined);
      assert.deepEqual(payload.results?.[0]?.durableAttentionReasons, ["context_pressure"]);
      assert.equal(finalStatus.activityState, undefined);
      assert.equal(finalStatus.steps?.[0]?.activityState, undefined);
      assert.equal(finalStatus.steps?.[0]?.idleEpisodeId, undefined);
      assert.equal(finalStatus.steps?.[0]?.compaction, undefined);
      assert.deepEqual(finalStatus.steps?.[0]?.durableAttentionReasons, ["context_pressure"]);
      const eventText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
      assert.doesNotMatch(eventText, /compaction_end/);
      const controls = eventText
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === "subagent.control");
      assert.equal(
        controls.filter((record) => record.event?.reason === "context_pressure").length,
        1,
      );
      assert.equal(controls.filter((record) => record.event?.reason === "idle").length, 0);
    }
  });

  it("background durable health survives validated activity and isolates per-child state", async () => {
    const markerDir = path.join(tempDir, "async-durable-health-markers");
    fs.mkdirSync(markerDir, { recursive: true });
    const release = path.join(markerDir, "release");
    mockPi.onCall({
      matchArgIncludes: "Implement the approved fixes",
      steps: [
        {
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "near context limit" }],
                provider: "mock",
                model: "test-model",
                stopReason: "toolUse",
                usage: {
                  totalTokens: 950,
                  input: 900,
                  output: 50,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0 },
                },
              },
            },
            events.toolStart("edit", { path: "src/health.ts" }),
            events.toolEnd("edit"),
            events.toolResult("edit", "No exact match", true),
            events.toolStart("edit", { path: "src/health.ts" }),
            events.toolEnd("edit"),
            events.toolResult("edit", "No exact match", true),
            events.toolStart("edit", { path: "src/health.ts" }),
            events.toolEnd("edit"),
            events.toolResult("edit", "No exact match", true),
          ],
        },
        {
          jsonl: [
            events.assistantMessage("validated durable state", "mock/test-model", "tool_use"),
          ],
        },
        { waitForMarker: release },
        { jsonl: [events.assistantMessage("final durable state")] },
      ],
    });
    mockPi.onCall({
      matchArgIncludes: "Investigate behavior",
      delay: 1_500,
      jsonl: [events.assistantMessage("sibling remains healthy")],
    });
    const id = `async-durable-health-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncParallel(id, {
      tasks: [
        { agent: "worker", task: "Implement the approved fixes" },
        { agent: "scout", task: "Investigate behavior" },
      ],
      agents: [makeAgent("worker"), makeAgent("scout")],
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: id },
      availableModels: [
        { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
      ],
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
      controlConfig: {
        enabled: true,
        needsAttentionAfterMs: 200,
        failedToolAttemptsBeforeAttention: 3,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      },
    });
    const durableObserved = await waitForAsyncControlCondition(asyncDir, (status, eventText) => {
      return (
        eventText.includes('"reason":"context_pressure"') &&
        eventText.includes('"reason":"tool_failures"') &&
        status.steps?.[0]?.durableAttentionReasons?.includes("context_pressure") === true &&
        status.steps?.[0]?.durableAttentionReasons?.includes("tool_failures") === true &&
        status.steps?.[0]?.activityState === "needs_attention" &&
        status.steps?.[1]?.activityState !== "needs_attention"
      );
    });
    assert.deepEqual(durableObserved.status.steps?.[0]?.durableAttentionReasons, [
      "context_pressure",
      "tool_failures",
    ]);
    assert.notEqual(durableObserved.status.steps?.[1]?.activityState, "needs_attention");
    assert.equal(durableObserved.status.steps?.[1]?.durableAttentionReasons, undefined);
    fs.writeFileSync(release, "", "utf-8");
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const finalStatus = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(payload.success, true);
    assert.deepEqual(payload.results?.[0]?.durableAttentionReasons, [
      "context_pressure",
      "tool_failures",
    ]);
    assert.deepEqual(finalStatus.steps?.[0]?.durableAttentionReasons, [
      "context_pressure",
      "tool_failures",
    ]);
    assert.equal(finalStatus.steps?.[0]?.activityState, "needs_attention");
    assert.equal(finalStatus.steps?.[1]?.durableAttentionReasons, undefined);
  });

  it("records background completion-guard attention durably", async () => {
    mockPi.onCall({ output: "I will plan the implementation before making edits." });
    const id = `async-completion-guard-health-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Implement the approved fixes",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: id },
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
      controlConfig: {
        enabled: true,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      },
    });
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    const eventText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
    assert.equal(payload.success, false);
    assert.match(eventText, /"reason":"completion_guard"/);
    assert.deepEqual(payload.results?.[0]?.durableAttentionReasons, ["completion_guard"]);
    assert.deepEqual(status.steps?.[0]?.durableAttentionReasons, ["completion_guard"]);
    assert.equal(status.steps?.[0]?.activityState, "needs_attention");
  });

  it("resets background idle episode identity across fallback attempts", async () => {
    const markerDir = path.join(tempDir, "async-fallback-health-markers");
    fs.mkdirSync(markerDir, { recursive: true });
    const needsAttentionAfterMs = 2_000;
    const firstRelease = path.join(markerDir, "first-release");
    const firstAttemptErrorActivity = path.join(markerDir, "first-attempt-error-activity");
    const firstAttemptFallbackRelease = path.join(markerDir, "first-attempt-fallback-release");
    const fallbackAttemptStarted = path.join(markerDir, "fallback-attempt-started");
    const fallbackAttemptRelease = path.join(markerDir, "fallback-attempt-release");
    const secondRelease = path.join(markerDir, "second-release");
    mockPi.onCall({
      exitCode: 1,
      steps: [
        { jsonl: [events.assistantMessage("first attempt", "mock/test-model", "tool_use")] },
        { waitForMarker: firstRelease },
        {
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "rate limit exceeded" }],
                model: "openai/gpt-5-mini",
                errorMessage: "rate limit exceeded",
                stopReason: "error",
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
              },
            },
          ],
          writeMarkerAfter: firstAttemptErrorActivity,
        },
        { waitForMarker: firstAttemptFallbackRelease },
      ],
    });
    mockPi.onCall({
      writeMarker: fallbackAttemptStarted,
      waitForMarker: fallbackAttemptRelease,
      steps: [
        { jsonl: [events.assistantMessage("fallback attempt", "mock/test-model", "tool_use")] },
        { waitForMarker: secondRelease },
        { jsonl: [events.assistantMessage("fallback completed")] },
      ],
    });
    const id = `async-fallback-health-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "scout",
      task: "Investigate behavior",
      agentConfig: makeAgent("scout", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4"],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: id },
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
      controlConfig: {
        enabled: true,
        needsAttentionAfterMs,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      },
    });
    await waitForAsyncControlCondition(asyncDir, (status, eventText) => {
      const idleControls = eventText
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === "subagent.control" && record.event?.reason === "idle");
      return (
        idleControls.length === 1 &&
        status.steps?.[0]?.activityState === "needs_attention" &&
        typeof status.steps?.[0]?.idleEpisodeId === "string"
      );
    });
    fs.writeFileSync(firstRelease, "", "utf-8");
    await waitForMarker(firstAttemptErrorActivity);
    // Keep the first attempt alive after its final validated error activity.
    // It may earn another idle episode here; that episode must not become the
    // fallback attempt's starting idle age.
    await new Promise((resolve) => setTimeout(resolve, needsAttentionAfterMs + 600));
    const attemptOneQuietEventText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
    const attemptOneIdleControls = attemptOneQuietEventText
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.type === "subagent.control" && record.event?.reason === "idle");
    assert.ok(attemptOneIdleControls.length >= 1);
    const attemptOneIdleCount = attemptOneIdleControls.length;
    const attemptOneIdleEpisodeIds = attemptOneIdleControls
      .map((record) => record.event?.idleEpisodeId)
      .filter((episodeId): episodeId is string => typeof episodeId === "string");
    fs.writeFileSync(firstAttemptFallbackRelease, "", "utf-8");
    await waitForMarker(fallbackAttemptStarted);
    // The output stream is opened for every attempt. Make the quiet fallback
    // explicitly have no fresh output so this checks the observation baseline,
    // not the stream-open timestamp.
    const outputPath = path.join(asyncDir, "output-0.log");
    const staleOutputTime = new Date(Date.now() - needsAttentionAfterMs - 800);
    fs.utimesSync(outputPath, staleOutputTime, staleOutputTime);
    // This is intentionally shorter than a fresh threshold. Pre-fix code uses
    // the prior attempt's old lastActivityAt and emits here; the fix starts a
    // new observation window at fallback dispatch.
    await new Promise((resolve) => setTimeout(resolve, needsAttentionAfterMs - 800));
    const fallbackPauseEventText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
    const fallbackPauseIdleControls = fallbackPauseEventText
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.type === "subagent.control" && record.event?.reason === "idle");
    const fallbackPauseStatus = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(fallbackPauseIdleControls.length, attemptOneIdleCount);
    assert.equal(fallbackPauseStatus.steps?.[0]?.activityState, undefined);
    fs.writeFileSync(fallbackAttemptRelease, "", "utf-8");
    const fallbackIdleObserved = await waitForAsyncControlCondition(
      asyncDir,
      (status, eventText) => {
        const idleControls = eventText
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter(
            (record) => record.type === "subagent.control" && record.event?.reason === "idle",
          );
        return (
          idleControls.length === attemptOneIdleCount + 1 &&
          status.steps?.[0]?.activityState === "needs_attention" &&
          typeof status.steps?.[0]?.idleEpisodeId === "string" &&
          !attemptOneIdleEpisodeIds.includes(status.steps?.[0]?.idleEpisodeId)
        );
      },
    );
    fs.writeFileSync(secondRelease, "", "utf-8");
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const eventText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
    const idleControls = eventText
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.type === "subagent.control" && record.event?.reason === "idle");
    assert.equal(payload.success, true);
    assert.equal(idleControls.length, attemptOneIdleCount + 1);
    const fallbackIdleEpisodeId = fallbackIdleObserved.status.steps?.[0]?.idleEpisodeId;
    if (typeof fallbackIdleEpisodeId !== "string") assert.fail("fallback idle episode is missing");
    assert.equal(idleControls.at(-1)?.event?.idleEpisodeId, fallbackIdleEpisodeId);
    assert.ok(!attemptOneIdleEpisodeIds.includes(fallbackIdleEpisodeId));
  });
});
