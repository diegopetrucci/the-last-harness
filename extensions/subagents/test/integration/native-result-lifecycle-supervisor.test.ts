/** Durable supervisor pause, continuation, and cancellation coverage. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR, RESULTS_DIR, resolveTempRootDir } from "../../src/shared/types.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  makeMinimalCtx,
  makeModel,
  removeTempDir,
} from "../support/helpers.ts";
import {
  available,
  expectUnsupportedChainRequest as expectUnsupportedChainRequestFor,
  isPidAlive,
  makeNativeResultLifecycleExecutor,
  normalizePathForComparison,
  readAsyncStatusJson,
  readMockCallArgs as readMockCallArgsFor,
  waitForAsyncState,
  waitForAsyncStatusPredicate,
  waitForMockPiCall as waitForMockPiCallFor,
  waitForRevivedAsyncResult,
  startedMockPiPids as startedMockPiPidsFor,
  type NativeExecutor,
  type NativeExecutorOptions,
} from "../support/native-result-lifecycle-fixtures.ts";
import { scaleTestTimeout, type ScaledMs } from "../support/scale-timeout.ts";

describe(
  "durable supervisor pause, continuation, and cancellation",
  { skip: !available ? "executor not importable" : undefined },
  () => {
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
      tempDir = createTempDir("pi-subagent-native-result-");
      mockPi.reset();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    function makeExecutor(options: NativeExecutorOptions = {}) {
      return makeNativeResultLifecycleExecutor(tempDir, options);
    }

    function readMockCallArgs(index: number): Promise<string[]> {
      return readMockCallArgsFor(mockPi, index);
    }

    function waitForMockPiCall(index: number, timeoutMs?: ScaledMs): Promise<void> {
      return waitForMockPiCallFor(mockPi, index, timeoutMs);
    }

    function startedMockPiPids(): number[] {
      return startedMockPiPidsFor(mockPi);
    }

    async function expectUnsupportedChainRequest(
      executor: NativeExecutor,
      requestId: string,
      request: Record<string, unknown>,
    ) {
      return expectUnsupportedChainRequestFor(executor, requestId, request, tempDir, mockPi);
    }

    it("status keeps paused foreground supervisor runs actionable and guided resume starts independent pressure state", async () => {
      const pressureMessage = (text: string, totalTokens = 800, model = "mock/test-model") => ({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          model,
          stopReason: "stop",
          usage: {
            totalTokens,
            input: totalTokens - 100,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      });
      const pressureContext = () => {
        const context = makeMinimalCtx(tempDir);
        context.model = makeModel("test-model", { provider: "mock" });
        context.modelRegistry.getAvailable = () => [
          makeModel("test-model", { provider: "mock", contextWindow: 1000 }),
          makeModel("resume-model", { provider: "mock", contextWindow: 2000 }),
        ];
        return context;
      };
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              pressureMessage("preserve before asking"),
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          {
            delay: scaleTestTimeout(1_000),
            jsonl: [events.assistantMessage("should not replay before resume")],
          },
        ],
      });
      mockPi.onCall({
        steps: [
          {
            delay: scaleTestTimeout(1_000),
            jsonl: [pressureMessage("resumed after supervisor reply", 1600, "mock/resume-model")],
          },
        ],
      });
      const { executor } = makeExecutor({
        agents: [makeAgent("a")],
      });
      const original = await executor.execute(
        "foreground-paused-status-original",
        { agent: "a", task: "ask supervisor" },
        new AbortController().signal,
        undefined,
        pressureContext(),
      );
      const runId = original.details?.runId;
      assert.ok(runId, "expected foreground run id");
      const pausedPressureStatus = readAsyncStatusJson<{
        steps?: Array<{
          contextPressure?: { severity?: string; crossedThreshold?: string };
          contextPressureCrossedThresholds?: string[];
        }>;
      }>(runId);
      assert.equal(pausedPressureStatus.steps?.[0]?.contextPressure?.severity, "warning");
      assert.equal(pausedPressureStatus.steps?.[0]?.contextPressure?.crossedThreshold, "warning");
      assert.deepEqual(pausedPressureStatus.steps?.[0]?.contextPressureCrossedThresholds, [
        "warning",
      ]);
      assert.match(original.content[0]?.text ?? "", /paused awaiting supervisor/i);
      assert.match(
        original.content[0]?.text ?? "",
        /Resume unchanged: subagent\(\{ action: "resume", id: "/,
      );
      assert.match(
        original.content[0]?.text ?? "",
        /Resume with guidance: subagent\(\{ action: "resume", id: ".*", message: "Supervisor replied: \.\.\." \}\)/,
      );
      assert.match(original.content[0]?.text ?? "", /action: "interrupt"/);

      const status = await executor.execute(
        "foreground-paused-status",
        { action: "status", id: runId },
        new AbortController().signal,
        undefined,
        pressureContext(),
      );
      const statusText = status.content[0]?.text ?? "";
      assert.match(statusText, /State: remembered foreground/);
      assert.match(statusText, /awaiting supervisor/);
      assert.match(
        statusText,
        /Resume unchanged: subagent\(\{ action: "resume", id: ".*", index: 0 \}\)/,
      );
      assert.match(
        statusText,
        /Resume with guidance: subagent\(\{ action: "resume", id: ".*", index: 0, message: "Supervisor replied: \.\.\." \}\)/,
      );
      assert.match(statusText, /action: "interrupt"/);
      assert.doesNotMatch(statusText, /Cwd:|Session:|Transcript: \/|Output: \//);

      const revived = await executor.execute(
        "foreground-paused-resume",
        {
          action: "resume",
          id: runId,
          message: "Supervisor replied: proceed with option A.",
          model: "mock/resume-model",
        },
        new AbortController().signal,
        undefined,
        pressureContext(),
      );
      assert.equal(revived.isError, undefined);
      assert.match(revived.content[0]?.text ?? "", /Revived foreground subagent from/);
      const revivedId = revived.details?.asyncId;
      assert.ok(revivedId, "expected revived async id");
      await waitForAsyncStatusPredicate(
        revivedId,
        (status) => status.state === "running",
        "revived pressure reset",
      );
      const initialRevivedStatus = readAsyncStatusJson<{
        steps?: Array<{ contextPressure?: unknown; contextPressureCrossedThresholds?: unknown }>;
      }>(revivedId);
      assert.equal(initialRevivedStatus.steps?.[0]?.contextPressure, undefined);
      assert.equal(initialRevivedStatus.steps?.[0]?.contextPressureCrossedThresholds, undefined);
      await waitForRevivedAsyncResult(revived);
      const completedRevivedStatus = readAsyncStatusJson<{
        steps?: Array<{
          contextPressure?: { severity?: string };
          contextPressureCrossedThresholds?: string[];
        }>;
      }>(revivedId);
      assert.equal(completedRevivedStatus.steps?.[0]?.contextPressure?.severity, "warning");
      assert.deepEqual(completedRevivedStatus.steps?.[0]?.contextPressureCrossedThresholds, [
        "warning",
      ]);
      const revivedControlEvents = fs
        .readFileSync(path.join(ASYNC_DIR, revivedId, "events.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; event?: { reason?: string } });
      assert.equal(
        revivedControlEvents.filter(
          (event) =>
            event.type === "subagent.control" && event.event?.reason === "context_pressure",
        ).length,
        1,
      );
      const selectedSession = original.details?.results?.[0]?.sessionFile;
      assert.ok(selectedSession, "expected paused child session file");
      const reviveArgs = await readMockCallArgs(1);
      assert.equal(reviveArgs[reviveArgs.indexOf("--session") + 1], selectedSession);
      assert.equal(mockPi.callCount(), 2);
    });

    it("resume unchanged revives a paused foreground supervisor run in the same session", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          {
            delay: scaleTestTimeout(1_000),
            jsonl: [events.assistantMessage("should not replay before resume")],
          },
        ],
      });
      mockPi.onCall({ output: "resumed without extra guidance" });
      const { executor } = makeExecutor({
        agents: [makeAgent("a")],
      });
      const original = await executor.execute(
        "foreground-paused-unchanged-original",
        { agent: "a", task: "ask supervisor" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      const runId = original.details?.runId;
      assert.ok(runId, "expected foreground run id");

      const revived = await executor.execute(
        "foreground-paused-unchanged-resume",
        { action: "resume", id: runId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(revived.isError, undefined);
      const revivedId = revived.details?.asyncId;
      assert.ok(revivedId, "expected revived run id");
      assert.equal(
        revived.content[0]?.text,
        [
          `Revived foreground subagent from ${runId}.`,
          `Revived run: ${revivedId}`,
          "Agent: a",
          `Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
        ].join("\n"),
      );
      await waitForRevivedAsyncResult(revived);
      const reviveArgs = await readMockCallArgs(1);
      const joinedArgs = reviveArgs.join(" ");
      assert.match(joinedArgs, /Continue under the existing task and instructions\./);
      assert.match(joinedArgs, /pause again rather than guess\./);
    });

    it("persists foreground lifecycle generations through paused and continued transitions", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          {
            delay: scaleTestTimeout(1_000),
            jsonl: [events.assistantMessage("should not replay before resume")],
          },
        ],
      });
      mockPi.onCall({ output: "resumed after persisted pause" });
      const { executor } = makeExecutor({
        agents: [makeAgent("a")],
      });
      const original = await executor.execute(
        "foreground-paused-generation-original",
        { agent: "a", task: "ask supervisor" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      const runId = original.details?.runId;
      assert.ok(runId, "expected foreground run id");
      const pausedStatus = readAsyncStatusJson<{
        state?: string;
        pid?: number;
        pause?: { ownerPid?: number };
        lifecycle?: { generation?: number };
        steps?: Array<{ status?: string }>;
      }>(runId);
      assert.equal(pausedStatus.state, "paused");
      assert.equal(pausedStatus.pid, undefined);
      assert.equal(pausedStatus.pause?.ownerPid, undefined);
      assert.equal(pausedStatus.steps?.[0]?.status, "paused");
      assert.ok((pausedStatus.lifecycle?.generation ?? -1) >= 2);

      const revived = await executor.execute(
        "foreground-paused-generation-resume",
        { action: "resume", id: runId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(revived.isError, undefined);
      await waitForRevivedAsyncResult(revived);
      await waitForAsyncState(runId, "continued");
      const continuedStatus = readAsyncStatusJson<{
        state?: string;
        pid?: number;
        pause?: { ownerPid?: number };
        lifecycle?: {
          generation?: number;
          continuation?: { claimToken?: string; continuedAt?: number };
        };
        steps?: Array<{ status?: string }>;
      }>(runId);
      assert.equal(continuedStatus.state, "continued");
      assert.equal(continuedStatus.pid, undefined);
      assert.equal(continuedStatus.pause?.ownerPid, undefined);
      assert.equal(continuedStatus.steps?.[0]?.status, "continued");
      assert.equal(typeof continuedStatus.lifecycle?.continuation?.claimToken, "string");
      assert.equal(typeof continuedStatus.lifecycle?.continuation?.continuedAt, "number");
      assert.ok(
        (continuedStatus.lifecycle?.generation ?? -1) > (pausedStatus.lifecycle?.generation ?? -1),
      );
    });

    it("disk-only paused foreground recovery supports status and unchanged resume", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          {
            delay: scaleTestTimeout(1_000),
            jsonl: [events.assistantMessage("should not replay before resume")],
          },
        ],
      });
      mockPi.onCall({ output: "resumed after reload" });
      const first = makeExecutor({
        agents: [makeAgent("a")],
      });
      const original = await first.executor.execute(
        "foreground-paused-reload-original",
        { agent: "a", task: "ask supervisor" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      const runId = original.details?.runId;
      assert.ok(runId, "expected foreground run id");
      assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${runId}.json`)), false);

      const reloaded = makeExecutor({
        agents: [makeAgent("a")],
      });
      const status = await reloaded.executor.execute(
        "foreground-paused-reload-status",
        { action: "status", id: runId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.match(status.content[0]?.text ?? "", /Paused lifecycle actions:/);
      assert.doesNotMatch(status.content[0]?.text ?? "", /Cwd:|Dir:|Session:|\/private|\/tmp\//);

      const revived = await reloaded.executor.execute(
        "foreground-paused-reload-resume",
        { action: "resume", id: runId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(revived.isError, undefined);
      assert.doesNotMatch(revived.content[0]?.text ?? "", /Session:|Async dir:|\/private|\/tmp\//);
      await waitForRevivedAsyncResult(revived);
      await waitForAsyncState(runId, "continued");

      const persistedStatus = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, runId, "status.json"), "utf-8"),
      ) as {
        state?: string;
        pause?: { kind?: string };
        lifecycle?: {
          continuation?: { continuationRunId?: string; continuedAt?: number; claimToken?: string };
        };
        pid?: number;
      };
      assert.equal(persistedStatus.state, "continued");
      assert.equal(persistedStatus.pause?.kind, "awaiting_supervisor");
      assert.equal(typeof persistedStatus.lifecycle?.continuation?.continuationRunId, "string");
      assert.equal(typeof persistedStatus.lifecycle?.continuation?.continuedAt, "number");
      assert.equal(persistedStatus.pid, undefined);
      assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${runId}.json`)), false);

      const duplicate = await reloaded.executor.execute(
        "foreground-paused-reload-resume-duplicate",
        { action: "resume", id: runId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(duplicate.isError, true);
      assert.match(duplicate.content[0]?.text ?? "", /already launched continuation/i);
      assert.doesNotMatch(
        duplicate.content[0]?.text ?? "",
        /Session:|Async dir:|\/private|\/tmp\//,
      );

      const cancelled = await reloaded.executor.execute(
        "foreground-paused-reload-cancel",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(cancelled.isError, true);
      assert.match(cancelled.content[0]?.text ?? "", /already continued/i);
      assert.doesNotMatch(
        cancelled.content[0]?.text ?? "",
        /Session:|Async dir:|\/private|\/tmp\//,
      );
    });

    it("persists paused foreground parallel cohorts with per-index actions and terminal transitions", async () => {
      const cohortPressureMessage = {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "running sibling partial output" }],
          model: "anthropic/claude-sonnet-4",
          stopReason: "stop",
          usage: { totalTokens: 800, input: 700, output: 100, cacheRead: 0, cacheWrite: 0 },
        },
      };
      mockPi.onCall({
        matchArgIncludes: "finish",
        jsonl: [events.assistantMessage("completed sibling")],
      });
      mockPi.onCall({
        matchArgIncludes: "ask supervisor",
        steps: [
          {
            delay: 200,
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          {
            delay: scaleTestTimeout(1_000),
            jsonl: [events.assistantMessage("should not replay before resume")],
          },
        ],
      });
      mockPi.onCall({
        matchArgIncludes: "keep working",
        steps: [{ delay: 50, jsonl: [cohortPressureMessage] }, { delay: 10_000 }],
      });
      mockPi.onCall({
        matchArgIncludes: "start late work",
        steps: [
          { delay: 50, jsonl: [events.assistantMessage("late-start sibling partial output")] },
          { delay: 10_000 },
        ],
      });
      mockPi.onCall({
        matchArgIncludes: "Continue under the existing task and instructions",
        output: "resumed requester",
      });
      const first = makeExecutor({
        agents: [
          makeAgent("done"),
          makeAgent("ask"),
          makeAgent("wait"),
          makeAgent("started"),
          makeAgent("queued"),
        ],
        config: { parallel: { concurrency: 3 } },
      });
      const cohortContext = makeMinimalCtx(tempDir);
      cohortContext.model = makeModel("test-model", { provider: "mock" });
      cohortContext.modelRegistry.getAvailable = () => [
        makeModel("claude-sonnet-4", { provider: "anthropic", contextWindow: 1000 }),
        makeModel("gpt-5-mini", { provider: "openai", contextWindow: 1000 }),
      ];
      const original = await first.executor.execute(
        "foreground-parallel-pause-original",
        {
          tasks: [
            { agent: "done", task: "finish" },
            { agent: "ask", task: "ask supervisor" },
            { agent: "wait", task: "keep working", model: "anthropic/claude-sonnet-4" },
            { agent: "started", task: "start late work", model: "openai/gpt-5-mini" },
            { agent: "queued", task: "must not start" },
          ],
        },
        new AbortController().signal,
        undefined,
        cohortContext,
      );
      const runId = original.details?.runId;
      assert.ok(runId, "expected foreground run id");
      assert.equal(mockPi.callCount(), 4);
      await waitForMockPiCall(0);
      const spawnedPids = startedMockPiPids();
      assert.equal(spawnedPids.length, 4);
      assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${runId}.json`)), false);
      await waitForAsyncState(runId, "paused");
      const pausedStatus = readAsyncStatusJson<{
        state?: string;
        steps?: Array<{
          status?: string;
          pause?: { kind?: string };
          terminationReason?: string;
          modelIdentity?: { provider: string; model: string; thinking?: string };
          contextPressure?: { severity?: string; crossedThreshold?: string };
          contextPressureCrossedThresholds?: string[];
        }>;
      }>(runId);
      assert.equal(pausedStatus.state, "paused");
      assert.equal(pausedStatus.steps?.[0]?.status, "completed");
      assert.equal(pausedStatus.steps?.[1]?.status, "paused");
      assert.equal(pausedStatus.steps?.[1]?.pause?.kind, "awaiting_supervisor");
      assert.equal(pausedStatus.steps?.[2]?.status, "paused");
      assert.equal(pausedStatus.steps?.[2]?.pause?.kind, "cohort_pause");
      assert.equal(pausedStatus.steps?.[2]?.terminationReason, "paused");
      assert.deepEqual(pausedStatus.steps?.[2]?.modelIdentity, {
        provider: "anthropic",
        model: "claude-sonnet-4",
      });
      assert.equal(pausedStatus.steps?.[2]?.contextPressure?.severity, "warning");
      assert.equal(pausedStatus.steps?.[2]?.contextPressure?.crossedThreshold, "warning");
      assert.deepEqual(pausedStatus.steps?.[2]?.contextPressureCrossedThresholds, ["warning"]);
      assert.equal(pausedStatus.steps?.[3]?.status, "paused");
      assert.equal(pausedStatus.steps?.[3]?.pause?.kind, "cohort_pause");
      assert.equal(pausedStatus.steps?.[3]?.terminationReason, "paused");
      assert.deepEqual(pausedStatus.steps?.[3]?.modelIdentity, {
        provider: "openai",
        model: "gpt-5-mini",
      });
      assert.equal(pausedStatus.steps?.[4]?.status, "pending");
      const requesterIndex =
        pausedStatus.steps?.findIndex((step) => step.pause?.kind === "awaiting_supervisor") ?? -1;
      const cohortIndexes =
        pausedStatus.steps?.flatMap((step, index) =>
          step.pause?.kind === "cohort_pause" ? [index] : [],
        ) ?? [];
      assert.equal(requesterIndex, 1);
      assert.deepEqual(cohortIndexes, [2, 3]);
      assert.deepEqual(
        spawnedPids.map((pid) => isPidAlive(pid)),
        [false, false, false, false],
      );

      const second = makeExecutor({
        agents: [
          makeAgent("done"),
          makeAgent("ask"),
          makeAgent("wait"),
          makeAgent("started"),
          makeAgent("queued"),
        ],
      });
      const status = await second.executor.execute(
        "foreground-parallel-pause-status",
        { action: "status", id: runId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      const statusText = status.content[0]?.text ?? "";
      assert.match(
        statusText,
        new RegExp(
          `Resume unchanged: subagent\\(\\{ action: "resume", id: ".*", index: ${requesterIndex} \\}\\)`,
        ),
      );
      for (const cohortIndex of cohortIndexes) {
        assert.match(
          statusText,
          new RegExp(
            `Resume child: subagent\\(\\{ action: "resume", id: ".*", index: ${cohortIndex}, message: "\\.\\.\\." \\}\\)`,
          ),
        );
        assert.match(
          statusText,
          new RegExp(
            `Cancel child: subagent\\(\\{ action: "interrupt", id: ".*", index: ${cohortIndex} \\}\\)`,
          ),
        );
      }

      const cancelled = await second.executor.execute(
        "foreground-parallel-pause-cancel",
        { action: "interrupt", id: runId, index: cohortIndexes[0] },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(cancelled.isError, undefined);
      assert.match(cancelled.content[0]?.text ?? "", new RegExp(`child ${cohortIndexes[0]}`));
      const afterCancel = readAsyncStatusJson<{
        steps?: Array<{ status?: string }>;
      }>(runId);
      assert.equal(afterCancel.steps?.[0]?.status, "completed");
      assert.equal(afterCancel.steps?.[requesterIndex]?.status, "paused");
      assert.equal(afterCancel.steps?.[cohortIndexes[0]]?.status, "cancelled");
      assert.equal(afterCancel.steps?.[cohortIndexes[1]]?.status, "paused");

      const revived = await second.executor.execute(
        "foreground-parallel-pause-resume",
        { action: "resume", id: runId, index: requesterIndex },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(revived.isError, undefined);
      await waitForRevivedAsyncResult(revived);

      const third = makeExecutor({
        agents: [
          makeAgent("done"),
          makeAgent("ask"),
          makeAgent("wait"),
          makeAgent("started"),
          makeAgent("queued"),
        ],
      });
      const duplicate = await third.executor.execute(
        "foreground-parallel-pause-duplicate",
        { action: "resume", id: runId, index: requesterIndex },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(duplicate.isError, true);
      assert.match(
        duplicate.content[0]?.text ?? "",
        /already launched (?:its )?continuation|already continued/i,
      );
      await waitForAsyncStatusPredicate(
        runId,
        (status) => status.steps?.[requesterIndex]?.status === "continued",
        "continued paused foreground parallel child",
      );
      const continuedStatus = readAsyncStatusJson<{
        state?: string;
        steps?: Array<{ status?: string }>;
      }>(runId);
      assert.equal(typeof continuedStatus.steps?.[0]?.status, "string");
      assert.equal(continuedStatus.steps?.[requesterIndex]?.status, "continued");
      assert.equal(continuedStatus.steps?.[cohortIndexes[0]]?.status, "cancelled");
      assert.equal(continuedStatus.steps?.[cohortIndexes[1]]?.status, "paused");
      assert.equal(typeof continuedStatus.steps?.[4]?.status, "string");
    });

    it("chain status flows fail closed before paused foreground recovery exists", async () => {
      const { executor } = makeExecutor({
        agents: [makeAgent("a"), makeAgent("b")],
      });

      const original = await expectUnsupportedChainRequest(
        executor,
        "foreground-chain-status-original",
        {
          chain: [
            { agent: "a", task: "ask supervisor" },
            { agent: "b", task: "must not run" },
          ],
        },
      );
      assert.equal(original.details?.runId, undefined);
    });

    it("chain parallel pause requests fail closed before any paused status is persisted", async () => {
      const first = makeExecutor({
        agents: [
          makeAgent("a"),
          makeAgent("done"),
          makeAgent("ask"),
          makeAgent("wait"),
          makeAgent("started"),
          makeAgent("queued"),
          makeAgent("later"),
        ],
      });
      const original = await expectUnsupportedChainRequest(
        first.executor,
        "foreground-chain-parallel-pause-original",
        {
          chain: [
            { agent: "a", task: "first" },
            {
              parallel: [
                { agent: "done", task: "parallel finish" },
                { agent: "ask", task: "parallel ask supervisor" },
                { agent: "wait", task: "parallel keep working" },
                { agent: "started", task: "parallel start late work" },
                { agent: "queued", task: "parallel must not start" },
              ],
              concurrency: 3,
            },
            { agent: "later", task: "later must not run" },
          ],
        },
      );
      assert.equal(original.details?.runId, undefined);
    });

    it("sequential chain pause requests fail closed before continuation state is created", async () => {
      const first = makeExecutor({
        agents: [makeAgent("a"), makeAgent("b"), makeAgent("c")],
      });
      const original = await expectUnsupportedChainRequest(
        first.executor,
        "foreground-sequential-chain-pause-original",
        {
          chain: [
            { agent: "a", task: "first" },
            { agent: "b", task: "ask supervisor" },
            { agent: "c", task: "must not run" },
          ],
        },
      );
      assert.equal(original.details?.runId, undefined);
    });

    it("interrupt makes a paused foreground supervisor run terminal, idempotent, and artifact-preserving", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          { delay: scaleTestTimeout(1_000), jsonl: [events.assistantMessage("after reply")] },
        ],
      });
      const { executor } = makeExecutor({
        agents: [makeAgent("a")],
      });
      const original = await executor.execute(
        "foreground-paused-cancel-original",
        { agent: "a", task: "ask supervisor" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      const runId = original.details?.runId;
      assert.ok(runId, "expected foreground run id");
      const outputPath = original.details?.results?.[0]?.artifactPaths?.outputPath;
      assert.ok(outputPath, "expected preserved output artifact path");
      const pausedStatus = readAsyncStatusJson<{
        state?: string;
        pid?: number;
        pause?: { ownerPid?: number };
        lifecycle?: { generation?: number };
      }>(runId);
      assert.equal(pausedStatus.state, "paused");
      assert.equal(pausedStatus.pid, undefined);
      assert.equal(pausedStatus.pause?.ownerPid, undefined);

      const cancelled = await executor.execute(
        "foreground-paused-cancel",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(cancelled.isError, undefined);
      assert.match(cancelled.content[0]?.text ?? "", /Cancelled paused foreground run/);
      assert.equal(fs.existsSync(outputPath!), true);
      const cancelledStatus = readAsyncStatusJson<{
        state?: string;
        pid?: number;
        pause?: { ownerPid?: number };
        cancel?: { cancelledAt?: number };
        lifecycle?: { generation?: number };
      }>(runId);
      assert.equal(cancelledStatus.state, "cancelled");
      assert.equal(cancelledStatus.pid, undefined);
      assert.equal(cancelledStatus.pause?.ownerPid, undefined);
      assert.equal(typeof cancelledStatus.cancel?.cancelledAt, "number");
      assert.ok(
        (cancelledStatus.lifecycle?.generation ?? -1) > (pausedStatus.lifecycle?.generation ?? -1),
      );

      const cancelledAgain = await executor.execute(
        "foreground-paused-cancel-again",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(cancelledAgain.isError, undefined);
      assert.match(cancelledAgain.content[0]?.text ?? "", /already cancelled/i);

      const resumed = await executor.execute(
        "foreground-paused-cancelled-resume",
        { action: "resume", id: runId, message: "Follow up" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(resumed.isError, true);
      assert.match(resumed.content[0]?.text ?? "", /cancelled while paused/);

      const status = await executor.execute(
        "foreground-paused-cancel-status",
        { action: "status", id: runId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.match(status.content[0]?.text ?? "", /cancelled/);
      assert.match(status.content[0]?.text ?? "", /kept its retained output\/session artifacts/i);
    });

    it("bounds paused-cancel lifecycle failures without leaking raw status paths", async () => {
      const defaultTempRoot = resolveTempRootDir({
        env: { ...process.env, PI_SUBAGENTS_TEMP_ROOT: "   " },
      });
      assert.notEqual(
        normalizePathForComparison(path.dirname(ASYNC_DIR)),
        normalizePathForComparison(defaultTempRoot),
        "malformed-status fixture must not target the live uid-scoped temp root",
      );

      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need direction",
              }),
            ],
          },
          { delay: scaleTestTimeout(1_000), jsonl: [events.assistantMessage("received pong")] },
        ],
      });
      const { executor } = makeExecutor({
        agents: [makeAgent("a")],
      });
      let runDir: string | undefined;
      let statusPath: string | undefined;
      let resultPath: string | undefined;
      try {
        const original = await executor.execute(
          "foreground-paused-cancel-failure-original",
          { agent: "a", task: "ask supervisor" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        const runId = original.details?.runId;
        if (typeof runId === "string" && runId.length > 0) {
          runDir = path.join(ASYNC_DIR, runId);
          statusPath = path.join(runDir, "status.json");
          resultPath = path.join(RESULTS_DIR, `${runId}.json`);
        }
        assert.ok(runId, "expected foreground run id");
        assert.ok(statusPath, "expected foreground status path");
        fs.writeFileSync(statusPath, "{not-json", "utf-8");

        const cancelled = await executor.execute(
          "foreground-paused-cancel-failure",
          { action: "interrupt", id: runId },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(cancelled.isError, true);
        assert.match(
          cancelled.content[0]?.text ?? "",
          /Foreground supervisor lifecycle update failed/,
        );
        assert.doesNotMatch(
          cancelled.content[0]?.text ?? "",
          /Failed to (inspect|read|parse) async status file/,
        );
        assert.doesNotMatch(cancelled.content[0]?.text ?? "", /status\.json|\/tmp\/|\/private\//);
      } finally {
        if (resultPath) fs.rmSync(resultPath, { force: true });
        if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
      }
    });

    it("resume action keeps exact foreground validation errors over async prefix matches", async () => {
      const base = `exact-invalid-${Date.now()}`;
      const asyncSession = path.join(tempDir, "async-exact-prefix.jsonl");
      fs.writeFileSync(asyncSession, "", "utf-8");
      const asyncDir = path.join(ASYNC_DIR, `${base}-async`);
      try {
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(
            {
              runId: `${base}-async`,
              mode: "single",
              state: "complete",
              startedAt: 100,
              lastUpdate: 200,
              cwd: tempDir,
              steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor, state } = makeExecutor({ agents: [makeAgent("a")] });
        state.foregroundRuns.set(base, {
          runId: base,
          mode: "single",
          cwd: tempDir,
          updatedAt: Date.now(),
          children: [{ agent: "a", index: 0, status: "completed" }],
        });

        const result = await executor.execute(
          "resume-exact-invalid-foreground",
          { action: "resume", id: base, message: "Follow up" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.match(
          result.content[0]?.text ?? "",
          /Foreground run '.+' child 0 does not have a persisted session file/,
        );
        assert.equal(mockPi.callCount(), 0);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
    });

    it("resume action keeps exact async validation errors over foreground prefix matches", async () => {
      const base = `exact-invalid-async-${Date.now()}`;
      const foregroundSession = path.join(tempDir, "foreground-exact-prefix.jsonl");
      fs.writeFileSync(foregroundSession, "", "utf-8");
      const asyncDir = path.join(ASYNC_DIR, base);
      try {
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(
            {
              runId: base,
              mode: "single",
              state: "complete",
              startedAt: 100,
              lastUpdate: 200,
              cwd: tempDir,
              steps: [{ agent: "a", status: "complete" }],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor, state } = makeExecutor({ agents: [makeAgent("a")] });
        state.foregroundRuns.set(`${base}-foreground`, {
          runId: `${base}-foreground`,
          mode: "single",
          cwd: tempDir,
          updatedAt: Date.now(),
          children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
        });

        const result = await executor.execute(
          "resume-exact-invalid-async",
          { action: "resume", id: base, message: "Follow up" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.match(
          result.content[0]?.text ?? "",
          /Async run '.+' child 0 does not have a persisted session file/,
        );
        assert.equal(mockPi.callCount(), 0);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
    });

    it("resume action reports async ambiguity even when foreground has one prefix match", async () => {
      const base = `namespace-ambiguous-${Date.now()}`;
      const foregroundSession = path.join(tempDir, "foreground-prefix.jsonl");
      const firstAsyncSession = path.join(tempDir, "async-a.jsonl");
      const secondAsyncSession = path.join(tempDir, "async-b.jsonl");
      fs.writeFileSync(foregroundSession, "", "utf-8");
      fs.writeFileSync(firstAsyncSession, "", "utf-8");
      fs.writeFileSync(secondAsyncSession, "", "utf-8");
      const firstAsyncDir = path.join(ASYNC_DIR, `${base}-async-a`);
      const secondAsyncDir = path.join(ASYNC_DIR, `${base}-async-b`);
      try {
        for (const [asyncDir, runId, sessionFile] of [
          [firstAsyncDir, `${base}-async-a`, firstAsyncSession],
          [secondAsyncDir, `${base}-async-b`, secondAsyncSession],
        ] as const) {
          fs.mkdirSync(asyncDir, { recursive: true });
          fs.writeFileSync(
            path.join(asyncDir, "status.json"),
            JSON.stringify(
              {
                runId,
                mode: "single",
                state: "complete",
                startedAt: 100,
                lastUpdate: 200,
                cwd: tempDir,
                steps: [{ agent: "a", status: "complete", sessionFile }],
              },
              null,
              2,
            ),
            "utf-8",
          );
        }
        const { executor, state } = makeExecutor({ agents: [makeAgent("a")] });
        state.foregroundRuns.set(`${base}-foreground`, {
          runId: `${base}-foreground`,
          mode: "single",
          cwd: tempDir,
          updatedAt: Date.now(),
          children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
        });

        const result = await executor.execute(
          "ambiguous-async-prefix-resume",
          { action: "resume", id: base, message: "Follow up" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /Ambiguous subagent run id prefix/);
      } finally {
        fs.rmSync(firstAsyncDir, { recursive: true, force: true });
        fs.rmSync(secondAsyncDir, { recursive: true, force: true });
      }
    });

    it("resume action reports ambiguous ids across remembered foreground and async runs", async () => {
      const base = `ambiguous-${Date.now()}`;
      const foregroundSession = path.join(tempDir, "foreground.jsonl");
      const asyncSession = path.join(tempDir, "async.jsonl");
      const asyncId = `${base}-async`;
      const foregroundId = `${base}-foreground`;
      const asyncDir = path.join(ASYNC_DIR, asyncId);
      fs.writeFileSync(foregroundSession, "", "utf-8");
      fs.writeFileSync(asyncSession, "", "utf-8");
      try {
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(
            {
              runId: asyncId,
              mode: "single",
              state: "complete",
              startedAt: 100,
              lastUpdate: 200,
              cwd: tempDir,
              steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor, state } = makeExecutor({ agents: [makeAgent("a")] });
        state.foregroundRuns.set(foregroundId, {
          runId: foregroundId,
          mode: "single",
          cwd: tempDir,
          updatedAt: Date.now(),
          children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
        });

        const result = await executor.execute(
          "ambiguous-resume",
          { action: "resume", id: base, message: "Follow up" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /ambiguous between foreground run/);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
    });
  },
);
