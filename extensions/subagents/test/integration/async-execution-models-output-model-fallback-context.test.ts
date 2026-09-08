/** Integration tests for async execution – model restoration, fallback, and context diagnostics. */

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

import { getThinkingLevelDropNote } from "../../src/runs/shared/pi-args.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import {
  lifecycleGeneration,
  transitionLifecycleStatus,
  withLifecycleContinuation,
} from "../../src/runs/shared/lifecycle-state.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";
import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  RESULTS_DIR,
  executeAsyncParallel,
  executeAsyncSingle,
  readMockPiArgs,
  requestAsyncInterrupt,
  waitForAsyncControlCondition,
  waitForAsyncResultFile,
  waitForAsyncStatusPredicate,
} from "../support/async-execution-helpers.ts";

describe("async execution model restoration and fallback", () => {
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

  it("background runs deliver warning and critical pressure controls exactly once", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "preserve progress" }],
            provider: "mock",
            model: "test-model:high",
            stopReason: "toolUse",
            usage: { totalTokens: 800, input: 700, output: 100, cacheRead: 0, cacheWrite: 0 },
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "finish narrowly" }],
            provider: "other",
            model: "other-model",
            stopReason: "stop",
            usage: { totalTokens: 950, input: 850, output: 100, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
    });
    const id = `async-pressure-controls-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Preserve the work.",
      agentConfig: makeAgent("worker", { completionGuard: false }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-pressure" },
      availableModels: [
        { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
        { provider: "other", id: "other-model", fullId: "other/other-model", contextWindow: 2000 },
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
      maxSubagentDepth: 2,
    });
    assert.equal(run.details.asyncId, id);
    await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

    assert.equal(payload.success, true);
    assert.deepEqual(payload.results?.[0]?.contextPressureCrossedThresholds, [
      "warning",
      "critical",
    ]);
    assert.equal(payload.results?.[0]?.contextUsage?.contextWindow, 1000);
    assert.equal(payload.results?.[0]?.contextUsage?.contextPercent, 95);
    assert.equal(payload.results[0]?.model, "mock/test-model:high");
    assert.deepEqual(payload.results[0]?.modelIdentity, {
      provider: "mock",
      model: "test-model",
      thinking: "high",
    });
    assert.equal(payload.results[0]?.modelResolution, undefined);
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.deepEqual(statusPayload.steps?.[0]?.contextPressureCrossedThresholds, [
      "warning",
      "critical",
    ]);
    assert.equal(statusPayload.steps?.[0]?.contextPressure?.severity, "critical");
    assert.equal(statusPayload.steps?.[0]?.contextPressure?.remainingTokens, 50);
    assert.deepEqual(statusPayload.steps?.[0]?.contextUsage, payload.results?.[0]?.contextUsage);
    assert.equal(statusPayload.steps?.[0]?.model, "mock/test-model:high");
    assert.equal(statusPayload.steps?.[0]?.thinking, "high");
    assert.deepEqual(statusPayload.steps?.[0]?.modelIdentity, {
      provider: "mock",
      model: "test-model",
      thinking: "high",
    });
    assert.equal(statusPayload.steps?.[0]?.modelResolution, undefined);
    const events = fs
      .readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const controls = events.filter((event) => event.type === "subagent.control");
    assert.deepEqual(
      controls.map((event) => event.event.contextPressureSeverity),
      ["warning", "critical"],
    );
    assert.deepEqual(
      controls.map((event) => event.event.contextPressureThreshold),
      ["warning", "critical"],
    );
  });

  it(
    "background pressure projection preserves a paused continuation reservation before its notice",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const markerDir = path.join(tempDir, "pressure-paused-race-markers");
      fs.mkdirSync(markerDir, { recursive: true });
      const readyMarker = path.join(markerDir, "child-ready");
      const releaseMarker = path.join(markerDir, "child-release");
      const afterPressureMarker = path.join(markerDir, "after-pressure");
      const pressureMessage = {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "buffered pressure update" }],
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
          { writeMarker: readyMarker },
          { waitForMarker: releaseMarker },
          { jsonl: [pressureMessage] },
          { waitForMarker: afterPressureMarker },
        ],
      });
      const id = `async-pressure-paused-race-${Date.now().toString(36)}`;
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Preserve the work while reporting context pressure.",
        agentConfig: makeAgent("worker", { completionGuard: false }),
        ctx: {
          pi: { events: { emit() {} } },
          cwd: tempDir,
          currentSessionId: "session-pressure-paused-race",
        },
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
        maxSubagentDepth: 2,
      });

      const asyncDir = path.join(ASYNC_DIR, id);
      const readyDeadline = Date.now() + scaleTestTimeout(20_000);
      while (!fs.existsSync(readyMarker)) {
        if (Date.now() > readyDeadline)
          assert.fail("Timed out waiting for pressure-race child ready marker");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      requestAsyncInterrupt(asyncDir, { source: "tlht-az3z-pressure-race" });
      const pausedPayload = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) => status.state === "paused",
        "paused checkpoint before buffered pressure message",
      );
      const pausedStatus = pausedPayload;
      const claimToken = "tlht-az3z-pressure-claim";
      transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: lifecycleGeneration(pausedStatus),
        mutate: (status) => ({
          ...status,
          lifecycle: withLifecycleContinuation(status, 0, {
            phase: "reserved",
            claimToken,
            claimedAt: 200,
            ownerPid: process.pid,
            continuationRunId: "tlht-az3z-pressure-continuation",
          }),
        }),
      });

      // The pressure message is the first buffered assistant output after the
      // paused checkpoint. This is the stale in-memory payload that the old bare
      // writer could use to erase the reservation.
      fs.writeFileSync(releaseMarker, "", "utf-8");
      const observed = await waitForAsyncControlCondition(asyncDir, (statusPayload, eventText) => {
        const status = statusPayload;
        const hasPressureNotice = eventText.split("\n").some((line) => {
          try {
            const record = JSON.parse(line) as { type?: string; event?: { reason?: string } };
            return (
              record.type === "subagent.control" && record.event?.reason === "context_pressure"
            );
          } catch {
            return false;
          }
        });
        return (
          hasPressureNotice &&
          status.state === "paused" &&
          status.lifecycle?.continuation?.claimToken === claimToken &&
          status.steps?.[0]?.contextPressure?.severity === "warning" &&
          status.steps?.[0]?.contextPressureCrossedThresholds?.[0] === "warning" &&
          status.steps?.[0]?.durableAttentionReasons?.includes("context_pressure") === true &&
          status.activityState === undefined &&
          status.steps?.[0]?.activityState === undefined &&
          status.steps?.[0]?.idleEpisodeId === undefined &&
          status.steps?.[0]?.compaction === undefined
        );
      });
      const observedStatus = observed.status;
      assert.deepEqual(observedStatus.steps?.[0]?.durableAttentionReasons, ["context_pressure"]);
      assert.equal(observedStatus.activityState, undefined);
      assert.equal(observedStatus.steps?.[0]?.activityState, undefined);
      assert.equal(observedStatus.steps?.[0]?.idleEpisodeId, undefined);
      assert.equal(observedStatus.steps?.[0]?.compaction, undefined);
      const pressureNotice = observed.eventText
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as { type?: string; event?: { reason?: string; ts?: number } };
          } catch {
            return undefined;
          }
        })
        .find(
          (record) =>
            record?.type === "subagent.control" && record.event?.reason === "context_pressure",
        );
      assert.ok(pressureNotice?.event?.ts, "pressure notice must carry its timestamp");
      assert.ok(
        (observedStatus.lastUpdate ?? 0) >= pressureNotice.event.ts,
        "pressure projection lastUpdate must be current before its notice is appended",
      );
      assert.equal(observedStatus.lifecycle?.continuation?.claimToken, claimToken);
      assert.equal(observedStatus.state, "paused");
      assert.deepEqual(observedStatus.steps?.[0]?.contextPressureCrossedThresholds, ["warning"]);

      fs.writeFileSync(afterPressureMarker, "", "utf-8");
      const resultPath = await waitForAsyncResultFile(id);
      const finalStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatus;
      const resultPayload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      assert.equal(resultPayload.state, "paused");
      assert.equal(finalStatus.state, "paused");
      assert.equal(finalStatus.lifecycle?.continuation?.claimToken, claimToken);
      assert.equal(finalStatus.steps?.[0]?.contextPressure?.severity, "warning");
      assert.deepEqual(finalStatus.steps?.[0]?.contextPressureCrossedThresholds, ["warning"]);
      assert.deepEqual(finalStatus.steps?.[0]?.durableAttentionReasons, ["context_pressure"]);
      assert.equal(finalStatus.activityState, undefined);
      assert.equal(finalStatus.steps?.[0]?.activityState, undefined);
      assert.equal(finalStatus.steps?.[0]?.idleEpisodeId, undefined);
      assert.equal(finalStatus.steps?.[0]?.compaction, undefined);
      assert.deepEqual(resultPayload.results?.[0]?.durableAttentionReasons, ["context_pressure"]);
      assert.equal(resultPayload.results?.[0]?.activityState, undefined);
      assert.equal(resultPayload.results?.[0]?.idleEpisodeId, undefined);
      assert.equal(resultPayload.results?.[0]?.compaction, undefined);
      const controlEvents = observed.eventText
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; event?: { reason?: string } })
        .filter(
          (record) =>
            record.type === "subagent.control" && record.event?.reason === "context_pressure",
        );
      assert.equal(controlEvents.length, 1, "pressure notice must be emitted exactly once");
    },
  );

  it("background parallel result persistence survives result-only recovery with pressure diagnostics", async () => {
    for (const output of ["parallel one", "parallel two"])
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: output }],
              model: "mock/test-model",
              stopReason: "stop",
              usage: { totalTokens: 800, input: 700, output: 100, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
      });
    const id = `async-parallel-pressure-recovery-${Date.now().toString(36)}`;
    const sessionFiles = [path.join(tempDir, `${id}-0.jsonl`), path.join(tempDir, `${id}-1.jsonl`)];
    for (const sessionFile of sessionFiles)
      fs.writeFileSync(sessionFile, '{"type":"session"}\n', "utf-8");
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    executeAsyncParallel(id, {
      tasks: [
        { agent: "reader", task: "Read" },
        { agent: "editor", task: "Edit" },
      ],
      agents: [
        makeAgent("reader", { model: "mock/test-model" }),
        makeAgent("editor", { model: "mock/test-model" }),
      ],
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-pressure-recovery",
      },
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
      sessionFilesByFlatIndex: sessionFiles,
      maxSubagentDepth: 2,
    });
    await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload & {
      results?: Array<{
        contextPressure?: { severity?: string };
        contextPressureCrossedThresholds?: string[];
      }>;
    };
    assert.deepEqual(
      payload.results?.map((child) => child.contextPressure?.severity),
      ["warning", "warning"],
    );
    assert.deepEqual(
      payload.results?.map((child) => child.contextPressureCrossedThresholds),
      [["warning"], ["warning"]],
    );
    const statusPath = path.join(asyncDir, "status.json");
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
    assert.equal(status.steps?.[0]?.contextPressure?.severity, "warning");
    assert.deepEqual(status.steps?.[0]?.contextPressureCrossedThresholds, ["warning"]);
    fs.rmSync(asyncDir, { recursive: true, force: true });
    const recovered = resolveAsyncResumeTarget(
      { id, index: 0 },
      { asyncDirRoot: ASYNC_DIR, resultsDir: RESULTS_DIR },
    );
    assert.equal(recovered.kind, "revive");
    assert.equal(recovered.contextPressure?.severity, "warning");
    assert.deepEqual(recovered.contextPressureCrossedThresholds, ["warning"]);
  });

  it("background runs record fallback attempts and final model", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "primary failed" }],
            model: "openai/gpt-5-mini",
            errorMessage: "rate limit exceeded",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 1,
    });
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Recovered asynchronously" }],
            provider: "mock",
            model: "test-model",
            stopReason: "stop",
            usage: { input: 1900, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
    });
    const id = `async-fallback-${Date.now().toString(36)}`;
    const sessionRoot = path.join(tempDir, "sessions");
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini:high",
        fallbackModels: ["anthropic/claude-sonnet-4:low"],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", contextWindow: 1000 },
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          fullId: "anthropic/claude-sonnet-4",
          contextWindow: 2000,
        },
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
      sessionRoot,
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);

    const started = Date.now();
    while (!fs.existsSync(resultPath)) {
      if (Date.now() - started > scaleTestTimeout(15_000)) {
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.equal(payload.lifecycleArtifactVersion, 1);
    assert.equal(payload.success, true);
    assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:low");
    assert.deepEqual(payload.results[0].modelIdentity, {
      provider: "anthropic",
      model: "claude-sonnet-4",
      thinking: "low",
    });
    assert.equal(payload.results[0].contextUsage?.contextWindow, 2000);
    assert.deepEqual(payload.results[0].attemptedModels, [
      "openai/gpt-5-mini:high",
      "anthropic/claude-sonnet-4:low",
    ]);
    assert.equal(payload.results[0].modelAttempts.length, 2);
    assert.deepEqual(payload.results[0].totalCost, {
      inputTokens: 1910,
      outputTokens: 5,
      costUsd: 0.01,
    });
    assert.deepEqual(payload.totalCost, { inputTokens: 1910, outputTokens: 5, costUsd: 0.01 });
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(statusPayload.lifecycleArtifactVersion, 1);
    assert.equal(statusPayload.steps?.[0]?.model, "anthropic/claude-sonnet-4:low");
    assert.equal(statusPayload.steps?.[0]?.thinking, "low");
    assert.ok(statusPayload.totalTokens!.total > 0);
    assert.ok(statusPayload.steps?.[0]?.tokens!.total > 0);
    assert.deepEqual(statusPayload.steps?.[0]?.totalCost, {
      inputTokens: 1910,
      outputTokens: 5,
      costUsd: 0.01,
    });
    assert.deepEqual(statusPayload.totalCost, {
      inputTokens: 1910,
      outputTokens: 5,
      costUsd: 0.01,
    });
    const events = fs
      .readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      events.find((event) => event.type === "subagent.run.started")?.lifecycleArtifactVersion,
      1,
    );
    const completed = events.find((event) => event.type === "subagent.run.completed");
    assert.equal(completed?.lifecycleArtifactVersion, 1);
    assert.deepEqual(completed?.totalCost, { inputTokens: 1910, outputTokens: 5, costUsd: 0.01 });
    assert.match(
      fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"),
      /Recovered asynchronously/,
    );
    assert.equal(mockPi.callCount(), 2);
  });

  it("propagates conservative registry filtering notices in background results", async () => {
    mockPi.onCall({ output: "Primary completed" });
    const primary = {
      provider: "openai",
      id: "gpt-5-mini",
      fullId: "openai/gpt-5-mini",
    };
    const backup = {
      provider: "anthropic",
      id: "claude-sonnet-4",
      fullId: "anthropic/claude-sonnet-4",
    };
    const id = `async-registry-filter-notice-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: primary.fullId,
        fallbackModels: [backup.fullId],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-filter" },
      availableModels: [primary],
      modelRegistry: { allModels: [primary, backup] },
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

    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.deepEqual(payload.results[0]?.attemptedModels, [primary.fullId]);
    assert.match(
      payload.results[0]?.modelFallbackNotice ?? "",
      /Skipped.*unavailable fallback model/,
    );
    assert.match(
      payload.results[0]?.modelFallbackNotice ?? "",
      /provider credentials|fallbackModels/,
    );
    assert.ok((payload.results[0]?.modelFallbackNotice ?? "").length <= 240);
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.match(
      status.steps?.[0]?.modelFallbackNotice ?? "",
      /Skipped.*unavailable fallback model/,
    );
    assert.equal(mockPi.callCount(), 1);
  });

  it("persists cached-token-heavy context diagnostics and termination reason", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            model: "mock/test-model",
            stopReason: "stop",
            usage: { input: 10, output: 5, cacheRead: 985, cacheWrite: 0, cost: { total: 0 } },
          },
        },
      ],
    });
    const id = `async-context-${Date.now().toString(36)}`;
    const restoredSessionFile = path.join(tempDir, "restored-context.jsonl");
    fs.writeFileSync(
      restoredSessionFile,
      '{"type":"session","version":1,"id":"restored-context","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n',
      "utf-8",
    );
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model: "mock/test-model" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 2000 },
      ],
      sessionFile: restoredSessionFile,
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
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.deepEqual(payload.results[0]?.contextUsage, {
      restoredTokens: 1000,
      contextTokens: 1000,
      peakTokens: 1000,
      contextWindow: 2000,
      contextPercent: 50,
    });
    assert.equal(payload.results[0]?.terminationReason, "completed");
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.deepEqual(status.steps?.[0]?.contextUsage, payload.results[0]?.contextUsage);
    assert.equal(status.steps?.[0]?.terminationReason, "completed");
  });

  it("fresh async runs do not mark a preallocated session path as restored", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Fresh" }],
            model: "mock/test-model",
            stopReason: "stop",
            usage: { input: 10, output: 5, cacheRead: 985, cacheWrite: 0, cost: { total: 0 } },
          },
        },
      ],
    });
    const id = `async-context-fresh-${Date.now().toString(36)}`;
    const sessionFile = path.join(tempDir, "fresh-preallocated.jsonl");
    fs.writeFileSync(sessionFile, "", "utf-8");
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do fresh work",
      agentConfig: makeAgent("worker", { model: "mock/test-model" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 2000 },
      ],
      sessionFile,
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
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.results[0]?.contextUsage?.restoredTokens, undefined);
    assert.equal(payload.results[0]?.terminationReason, "completed");
  });

  it("background durable resumes let explicit model overrides beat the restored identity and label them overrides", async () => {
    mockPi.onCall({ output: "Resumed with explicit override" });
    const id = `async-resume-override-${Date.now().toString(36)}`;
    const availableModels = [
      { provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
      { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
    ];
    const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Continue the paused work",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels,
      modelOverride: "openai/gpt-5",
      restoredModelIdentity: restored,
      modelResolution: {
        kind: "override",
        original: restored,
        reason:
          "Caller explicitly overrode persisted selection anthropic/claude-sonnet-4:high with 'openai/gpt-5'.",
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
    });

    assert.equal(run.details.asyncId, id);
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.model, "openai/gpt-5");
    assert.equal(payload.results[0]?.modelResolution?.kind, "override");
    assert.deepEqual(payload.results[0]?.modelResolution?.original, restored);
    assert.deepEqual(payload.results[0]?.modelResolution?.resumed, {
      provider: "openai",
      model: "gpt-5",
    });
    assert.match(
      payload.results[0]?.modelResolution?.reason ?? "",
      /explicitly overrode persisted selection/,
    );
    const args = readMockPiArgs(mockPi, 0);
    assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
  });

  it("background durable resumes keep unavailable restored models visible through runtime fallback", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "restored model failed" }],
            model: "anthropic/claude-sonnet-4",
            errorMessage: "rate limit exceeded",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 1,
    });
    mockPi.onCall({ output: "Recovered on fallback model" });
    const id = `async-resume-unavailable-${Date.now().toString(36)}`;
    const availableModels = [{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" }];
    const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Continue the paused work",
      agentConfig: makeAgent("worker", { fallbackModels: ["openai/gpt-5"] }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels,
      restoredModelIdentity: restored,
      modelResolution: {
        kind: "restored",
        original: restored,
        resumed: restored,
        reason:
          "Restored persisted child selection anthropic/claude-sonnet-4:high instead of the current parent model.",
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
    });

    assert.equal(run.details.asyncId, id);
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.model, "openai/gpt-5:high");
    assert.deepEqual(payload.results[0]?.attemptedModels, [
      "anthropic/claude-sonnet-4:high",
      "openai/gpt-5:high",
    ]);
    assert.equal(payload.results[0]?.modelResolution?.kind, "fallback");
    assert.deepEqual(payload.results[0]?.modelResolution?.original, restored);
    assert.deepEqual(payload.results[0]?.modelResolution?.resumed, {
      provider: "openai",
      model: "gpt-5",
      thinking: "high",
    });
    const reason = payload.results[0]?.modelResolution?.reason ?? "";
    assert.match(reason, /not present in the current model registry/);
    assert.match(
      reason,
      /Runtime fallback selected 'openai\/gpt-5:high' after 'anthropic\/claude-sonnet-4:high' failed/,
    );
    assert.equal(mockPi.callCount(), 2);
  });

  it("background runtime fallback persists the full transition in status during the crash window", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "restored model failed" }],
            model: "anthropic/claude-sonnet-4",
            errorMessage: "rate limit exceeded",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 1,
    });
    mockPi.onCall({ output: "Recovered on fallback model", delay: scaleTestTimeout(3_000) });
    const id = `async-fallback-crash-window-${Date.now().toString(36)}`;
    const availableModels = [{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" }];
    const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Continue the paused work",
      agentConfig: makeAgent("worker", { fallbackModels: ["openai/gpt-5"] }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels,
      restoredModelIdentity: restored,
      modelResolution: {
        kind: "restored",
        original: restored,
        resumed: restored,
        reason:
          "Restored persisted child selection anthropic/claude-sonnet-4:high instead of the current parent model.",
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
    });

    // Simulated crash window: the second (fallback) attempt is running but the
    // terminal result has not been persisted yet. The last status write must
    // already carry the original identity, fallback reason, attempted models,
    // and completed attempt history so a durable resume after a crash cannot
    // mistake the fallback for the original selection.
    const crashWindowStatus = await waitForAsyncStatusPredicate(
      path.join(ASYNC_DIR, id),
      (status) =>
        status.steps?.[0]?.modelResolution?.kind === "fallback" &&
        status.steps?.[0]?.modelAttempts?.length === 1,
      "fallback transition persisted before the terminal result",
    );
    assert.ok(
      !fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)),
      "expected the crash-window snapshot before the terminal result was persisted",
    );
    const step = crashWindowStatus.steps?.[0];
    assert.equal(step?.model, "openai/gpt-5:high");
    assert.deepEqual(step?.modelIdentity, { provider: "openai", model: "gpt-5", thinking: "high" });
    assert.deepEqual(step?.modelResolution?.original, restored);
    assert.deepEqual(step?.modelResolution?.resumed, {
      provider: "openai",
      model: "gpt-5",
      thinking: "high",
    });
    assert.match(
      step?.modelResolution?.reason ?? "",
      /Runtime fallback selected 'openai\/gpt-5:high' after 'anthropic\/claude-sonnet-4:high' failed/,
    );
    assert.deepEqual(step?.attemptedModels, [
      "anthropic/claude-sonnet-4:high",
      "openai/gpt-5:high",
    ]);
    assert.equal(step?.modelAttempts?.[0]?.success, false);

    // The run then completes normally with the terminal resolution intact.
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.modelResolution?.kind, "fallback");
    assert.deepEqual(payload.results[0]?.modelResolution?.original, restored);
  });

  it("background durable resumes surface model-scope violations for restored selections without silent switches", async () => {
    mockPi.onCall({ output: "Resumed outside the configured scope" });
    const id = `async-resume-scope-${Date.now().toString(36)}`;
    const availableModels = [
      { provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
      { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
    ];
    const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Continue the paused work",
      agentConfig: makeAgent("worker"),
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-1",
        modelScope: { enforce: true, allow: ["openai/*"] },
      },
      availableModels,
      restoredModelIdentity: restored,
      modelResolution: {
        kind: "restored",
        original: restored,
        resumed: restored,
        reason:
          "Restored persisted child selection anthropic/claude-sonnet-4:high instead of the current parent model.",
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
    });

    assert.equal(run.details.asyncId, id);
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4:high");
    assert.equal(payload.results[0]?.modelResolution?.kind, "restored");
    assert.deepEqual(payload.results[0]?.modelResolution?.resumed, restored);
    const reason = payload.results[0]?.modelResolution?.reason ?? "";
    assert.match(reason, /Restored persisted child selection/);
    assert.match(reason, /outside the configured subagent model scope/);
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(statusPayload.steps?.[0]?.modelResolution?.kind, "restored");
    assert.deepEqual(statusPayload.steps?.[0]?.modelIdentity, restored);
    assert.equal(statusPayload.steps?.[0]?.thinking, "high");
  });

  it("background runs surface a dropped thinking level once without changing the model arg", async () => {
    mockPi.onCall({ output: "Done asynchronously" });
    const id = `async-thinking-drop-${Date.now().toString(36)}`;
    const availableModels = [
      {
        provider: "openai",
        id: "gpt-5",
        fullId: "openai/gpt-5",
        reasoning: true,
        thinkingLevelMap: { max: null },
      },
    ];
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model: "openai/gpt-5", thinking: "max" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels,
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

    assert.equal(run.details.asyncId, id);
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    const note = getThinkingLevelDropNote("openai/gpt-5", "max", false, { availableModels });
    assert.ok(note);
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.model, "openai/gpt-5");
    assert.equal((payload.results[0]?.output?.split(note) ?? []).length - 1, 1);
    assert.equal(
      (statusPayload.steps?.[0]?.recentOutput?.filter((line) => line === note) ?? []).length,
      1,
    );
    const args = readMockPiArgs(mockPi, 0);
    assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
  });

  it("background runs preserve a max thinking suffix when capability metadata is missing", async () => {
    mockPi.onCall({ output: "Done asynchronously" });
    const id = `async-thinking-metadata-missing-${Date.now().toString(36)}`;
    const model = "anthropic/claude-sonnet-4-5";
    const availableModels = [
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        fullId: model,
        reasoning: true,
      },
    ];
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model, thinking: "max" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels,
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

    assert.equal(run.details.asyncId, id);
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.model, `${model}:max`);
    assert.equal(getThinkingLevelDropNote(model, "max", false, { availableModels }), undefined);
    const args = readMockPiArgs(mockPi, 0);
    assert.equal(args[args.indexOf("--model") + 1], `${model}:max`);
  });

  it("background runs try agent fallback models and only persist notices after a retry", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "primary failed" }],
            model: "openai/gpt-5-mini",
            errorMessage: "429 quota exceeded",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 0,
    });
    mockPi.onCall({ output: "Recovered asynchronously on agent fallback" });
    const id = `async-dispatch-fallback-${Date.now().toString(36)}`;
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["google/gemini-2.5-pro"],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      modelFallbackNotice: "Agent fallback engaged",
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

    const started = Date.now();
    while (!fs.existsSync(resultPath)) {
      if (Date.now() - started > scaleTestTimeout(15_000)) {
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.deepEqual(payload.results[0].attemptedModels, [
      "openai/gpt-5-mini",
      "google/gemini-2.5-pro",
    ]);
    assert.equal(payload.results[0].modelFallbackNotice, "Agent fallback engaged");
    assert.match(payload.results[0].output ?? "", /^\[fallback\]/);
    assert.match(payload.results[0].output ?? "", /Notice: Agent fallback engaged/);
    assert.equal(mockPi.callCount(), 2);
  });

  it("background single applies agent thinking to primary and fallback suffixes", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "primary failed" }],
            model: "openai/gpt-5-mini",
            errorMessage: "rate limit exceeded",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 1,
    });
    mockPi.onCall({ output: "Recovered asynchronously" });
    const id = `async-fallback-thinking-off-${Date.now().toString(36)}`;
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4"],
        thinking: "off",
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
        { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
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

    assert.equal(run.details.asyncId, id);
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const firstArgs = readMockPiArgs(mockPi, 0);
    const secondArgs = readMockPiArgs(mockPi, 1);
    assert.equal(payload.success, true);
    assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:off");
    assert.deepEqual(payload.results[0].attemptedModels, [
      "openai/gpt-5-mini:off",
      "anthropic/claude-sonnet-4:off",
    ]);
    assert.equal(firstArgs[firstArgs.indexOf("--model") + 1], "openai/gpt-5-mini:off");
    assert.equal(secondArgs[secondArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4:off");
  });

  it("background runs retry fallback models when a zero-exit attempt has empty output", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            model: "openai/gpt-5-mini",
            stopReason: "error",
            usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 0,
    });
    mockPi.onCall({ output: "Recovered asynchronously from empty output" });
    const id = `async-empty-output-fallback-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4"],
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

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4");
    assert.match(payload.results[0]?.output ?? "", /Recovered asynchronously from empty output/);
    assert.match(payload.results[0]?.modelAttempts?.[0]?.error ?? "", /no output/i);
    assert.deepEqual(
      payload.results[0]?.modelAttempts?.map((attempt) => attempt.success),
      [false, true],
    );
    assert.equal(mockPi.callCount(), 2);
  });

  it("background fallback does not combine failed pressure diagnostics with a later empty attempt", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "failed-call", name: "edit", arguments: { path: "a.ts" } },
            ],
            model: "openai/gpt-5-mini",
            stopReason: "toolUse",
            usage: {
              totalTokens: 990,
              input: 900,
              output: 90,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { total: 0 },
            },
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "provider failure" }],
            model: "openai/gpt-5-mini",
            stopReason: "error",
            errorMessage: "429 quota exceeded",
          },
        },
      ],
      exitCode: 0,
    });
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "successful-call",
                name: "edit",
                arguments: { path: "b.ts" },
              },
            ],
            model: "anthropic/claude-sonnet-4",
            stopReason: "toolUse",
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            model: "anthropic/claude-sonnet-4",
            stopReason: "stop",
          },
        },
      ],
    });
    const id = `async-fallback-context-pressure-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4"],
        completionGuard: false,
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", contextWindow: 1000 },
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          fullId: "anthropic/claude-sonnet-4",
          contextWindow: 1000,
        },
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
      maxSubagentDepth: 2,
    });

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.notEqual(payload.results[0]?.terminationReason, "context_exhausted");
    assert.doesNotMatch(
      payload.results[0]?.error ?? "",
      /unfinished tool interaction under high context pressure/,
    );
    assert.equal(payload.results[0]?.contextUsage?.contextPercent, 99);
    assert.deepEqual(
      payload.results[0]?.modelAttempts?.map((attempt) => attempt.success),
      [false, true],
    );
  });

  it("background acceptance reports do not become context-exhausted empty terminals", async () => {
    const acceptanceReport = [
      "```acceptance-report",
      JSON.stringify({
        criteriaSatisfied: [
          { id: "criterion-1", status: "satisfied", evidence: "terminal report" },
        ],
        changedFiles: [],
        testsAddedOrUpdated: [],
        commandsRun: [],
        validationOutput: [],
        residualRisks: [],
        noStagedFiles: true,
      }),
      "```",
    ].join("\n");
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-acceptance-bg",
                name: "edit",
                arguments: { path: "a.ts" },
              },
            ],
            model: "mock/test-model",
            stopReason: "toolUse",
            usage: {
              totalTokens: 990,
              input: 900,
              output: 90,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { total: 0 },
            },
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: acceptanceReport }],
            model: "mock/test-model",
            stopReason: "stop",
            usage: {
              totalTokens: 990,
              input: 900,
              output: 90,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { total: 0 },
            },
          },
        },
      ],
    });
    const id = `async-context-acceptance-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Finish the edit.",
      agentConfig: makeAgent("worker", { model: "mock/test-model", completionGuard: false }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      acceptance: false,
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

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.exitCode, 0);
    assert.equal(payload.results[0]?.terminationReason, "completed");
    assert.equal(payload.results[0]?.contextUsage?.contextPercent, 99);
    assert.equal(payload.results[0]?.output, "");
  });

  it("background runs fail zero-exit provider errors when no fallback succeeds", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "quota hit" }],
            model: "openai/gpt-5-mini",
            errorMessage: "429 quota exceeded",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 0,
    });
    const id = `async-zero-exit-provider-error-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
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

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, false);
    assert.match(payload.results[0]?.error ?? "", /429 quota exceeded/);
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(statusPayload.state, "failed");
    assert.match(statusPayload.steps?.[0]?.error ?? "", /429 quota exceeded/);
  });

  it("background runs treat recovered child errors as successful", async () => {
    mockPi.onCall({
      jsonl: [
        events.toolResult("read", "EISDIR: illegal operation on a directory", true),
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "temporary provider failure" }],
            model: "openai/gpt-5-mini",
            stopReason: "error",
            errorMessage: "provider transport failed",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
        events.assistantMessage("Recovered asynchronously"),
      ],
    });
    const id = `async-recovered-child-error-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
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

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.state, "complete");
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.results[0]?.success, true);
    assert.equal(payload.results[0]?.error, undefined);
    assert.equal(payload.results[0]?.output, "Recovered asynchronously");
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(statusPayload.state, "complete");
    assert.equal(statusPayload.steps?.[0]?.status, "complete");
    assert.equal(statusPayload.steps?.[0]?.exitCode, 0);
  });

  it("background runs keep provider errors failed when followed only by empty assistant output", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "temporary provider failure" }],
            model: "openai/gpt-5-mini",
            stopReason: "error",
            errorMessage: "provider transport failed",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
        events.assistantMessage(""),
      ],
    });
    const id = `async-provider-error-empty-stop-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
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

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, false);
    assert.equal(payload.state, "failed");
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.results[0]?.success, false);
    assert.match(payload.results[0]?.error ?? "", /provider transport failed/);
    assert.equal(payload.results[0]?.output, "");
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(statusPayload.state, "failed");
    assert.equal(statusPayload.steps?.[0]?.status, "failed");
    assert.equal(statusPayload.steps?.[0]?.exitCode, 1);
  });
});
