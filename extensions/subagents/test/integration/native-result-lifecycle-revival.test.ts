/** Completed-run revival and exact-id recovery coverage. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  SUBAGENT_ASYNC_STARTED_EVENT,
  resolveTempRootDir,
} from "../../src/shared/types.ts";
import {
  consumeChildMessageRequests,
  steerRequestsDir,
  writeChildMessageAcceptance,
} from "../../src/runs/background/control-channel.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { getArtifactsDir } from "../../src/shared/artifacts.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";
import {
  available,
  makeNativeResultLifecycleExecutor,
  readAsyncStatusJson,
  readMockCallArgs as readMockCallArgsFor,
  waitForAsyncStatusPredicate,
  waitForFile,
  waitForMockPiCall as waitForMockPiCallFor,
  waitForRevivedAsyncResult,
  type NativeExecutorOptions,
} from "../support/native-result-lifecycle-fixtures.ts";
import { scaleTestTimeout, type ScaledMs } from "../support/scale-timeout.ts";

describe(
  "completed-run revival",
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

    it("resume action queues a live async follow-up in the native inbox", async () => {
      const runId = `resume-live-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
      let acknowledged = false;
      try {
        fs.mkdirSync(asyncDir, { recursive: true });
        const sessionFile = path.join(asyncDir, "worker.jsonl");
        fs.writeFileSync(sessionFile, "", "utf-8");
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(
            {
              runId,
              mode: "single",
              state: "running",
              pid: process.pid,
              sessionId: "session-123",
              startedAt: 100,
              lastUpdate: Date.now(),
              sessionFile,
              steps: [{ agent: "worker", status: "running", sessionFile }],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor } = makeExecutor({
          kill: (pid, signal) => {
            kills.push({ pid, signal });
            if (!acknowledged && signal === 0) {
              const requestDir = steerRequestsDir(asyncDir);
              const requestFile = fs.existsSync(requestDir)
                ? fs.readdirSync(requestDir)[0]
                : undefined;
              if (requestFile) {
                const request = JSON.parse(
                  fs.readFileSync(path.join(requestDir, requestFile), "utf-8"),
                ) as {
                  id: string;
                };
                writeChildMessageAcceptance(asyncDir, {
                  requestId: request.id,
                  type: "resume",
                  status: "accepted",
                  ts: Date.now(),
                  acceptedIndexes: [0],
                });
                acknowledged = true;
              }
            }
            return true;
          },
        });

        const result = await executor.execute(
          "resume-live",
          { action: "resume", id: runId, message: "Can you clarify the last change?" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.match(
          result.content[0]?.text ?? "",
          new RegExp(`Resume follow-up accepted for live async run ${runId} child 0`),
        );
        assert.equal(
          kills.every(({ signal }) => signal === 0),
          true,
        );
        const requests = consumeChildMessageRequests(asyncDir);
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.type, "resume");
        assert.equal(requests[0]?.targetIndex, 0);
        assert.equal(requests[0]?.message, "Can you clarify the last change?");
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
    });

    it("resume action rejects chain-root continuation requests for live and completed async runs", async () => {
      const sourceRunId = `resume-chain-root-${Date.now()}`;
      const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
      const sourceResultPath = path.join(RESULTS_DIR, `${sourceRunId}.json`);
      const sourceSession = path.join(tempDir, "source-child.jsonl");
      try {
        fs.mkdirSync(sourceAsyncDir, { recursive: true });
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
        fs.writeFileSync(sourceSession, "", "utf-8");
        fs.writeFileSync(
          path.join(sourceAsyncDir, "status.json"),
          JSON.stringify(
            {
              runId: sourceRunId,
              mode: "single",
              state: "running",
              pid: process.pid,
              startedAt: 100,
              lastUpdate: 100,
              cwd: tempDir,
              steps: [{ agent: "worker", status: "running", sessionFile: sourceSession }],
            },
            null,
            2,
          ),
          "utf-8",
        );
        fs.writeFileSync(
          sourceResultPath,
          JSON.stringify(
            {
              id: sourceRunId,
              agent: "worker",
              mode: "single",
              success: true,
              state: "complete",
              summary: "root output",
              results: [
                {
                  agent: "worker",
                  output: "root output",
                  success: true,
                  sessionFile: sourceSession,
                },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor, events } = makeExecutor({
          agents: [makeAgent("worker"), makeAgent("reviewer")],
        });
        const chainRequest = {
          action: "resume",
          id: sourceRunId,
          chain: [{ agent: "reviewer", task: "Review this root result: {previous}" }],
        } as const;

        const liveResult = await executor.execute(
          "resume-chain-root-live",
          chainRequest,
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(liveResult.isError, true);
        assert.match(
          liveResult.content[0]?.text ?? "",
          /Saved chains are deliberately unsupported/,
        );
        assert.equal(
          events.emitted.find((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT),
          undefined,
        );

        fs.writeFileSync(
          path.join(sourceAsyncDir, "status.json"),
          JSON.stringify(
            {
              runId: sourceRunId,
              mode: "single",
              state: "complete",
              startedAt: 100,
              lastUpdate: 200,
              cwd: tempDir,
              steps: [{ agent: "worker", status: "complete" }],
            },
            null,
            2,
          ),
          "utf-8",
        );

        const completedResult = await executor.execute(
          "resume-chain-root-complete",
          chainRequest,
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(completedResult.isError, true);
        assert.match(
          completedResult.content[0]?.text ?? "",
          /Saved chains are deliberately unsupported/,
        );
        assert.equal(
          events.emitted.find((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT),
          undefined,
        );
      } finally {
        fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
        fs.rmSync(sourceResultPath, { force: true });
      }
    });

    it("resume action revives completed async runs with the current session model when the child is unconfigured", async () => {
      mockPi.onCall({ output: "revived answer" });
      const runId = `resume-revive-inherit-model-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sessionFile = path.join(tempDir, "child-session-inherit-model.jsonl");
      try {
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(sessionFile, "", "utf-8");
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
              sessionFile,
              steps: [{ agent: "worker", status: "complete" }],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor } = makeExecutor({
          agents: [makeAgent("worker", { output: "resume-report.md" })],
        });

        const result = await executor.execute(
          "resume-revive-inherit-model",
          { action: "resume", id: runId, message: "What changed?", output: "resume-report.md" },
          new AbortController().signal,
          undefined,
          {
            ...makeMinimalCtx(tempDir),
            model: { provider: "github-copilot", id: "gpt-5-mini" },
          },
        );

        assert.equal(result.isError, undefined);
        const revivedId = await waitForRevivedAsyncResult(result);
        const args = await readMockCallArgs(0);
        const modelIndex = args.indexOf("--model");
        assert.notEqual(modelIndex, -1);
        assert.equal(args[modelIndex + 1], "github-copilot/gpt-5-mini");
        const payload = JSON.parse(
          fs.readFileSync(path.join(RESULTS_DIR, `${revivedId}.json`), "utf-8"),
        ) as {
          results?: Array<{ artifactPaths?: { outputPath?: string } }>;
        };
        const artifactOutputPath = payload.results?.[0]?.artifactPaths?.outputPath;
        assert.equal(
          artifactOutputPath,
          path.join(getArtifactsDir(null), `${revivedId}_worker_output.md`),
        );
        assert.equal(fs.existsSync(artifactOutputPath), true);
        assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
    });

    it("resume action keeps an explicit model override authoritative when reviving a completed async run", async () => {
      mockPi.onCall({ output: "revived answer" });
      const runId = `resume-revive-explicit-model-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sessionFile = path.join(tempDir, "child-session-explicit-model.jsonl");
      try {
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(sessionFile, "", "utf-8");
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
              sessionFile,
              steps: [{ agent: "worker", status: "complete" }],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor } = makeExecutor({
          agents: [makeAgent("worker", { model: "openai/gpt-4o" })],
        });

        const result = await executor.execute(
          "resume-revive-explicit-model",
          {
            action: "resume",
            id: runId,
            message: "What changed?",
            model: "anthropic/claude-sonnet-4",
          },
          new AbortController().signal,
          undefined,
          {
            ...makeMinimalCtx(tempDir),
            model: { provider: "github-copilot", id: "gpt-5-mini" },
          },
        );

        assert.equal(result.isError, undefined);
        await waitForRevivedAsyncResult(result);
        const args = await readMockCallArgs(0);
        const modelIndex = args.indexOf("--model");
        assert.notEqual(modelIndex, -1);
        assert.equal(args[modelIndex + 1], "anthropic/claude-sonnet-4");
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
    });

    it("resume action revives completed multi-child async runs by index", async () => {
      mockPi.onCall({ output: "revived async child b" });
      const runId = `resume-revive-multi-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const firstSession = path.join(tempDir, "child-a.jsonl");
      const secondSession = path.join(tempDir, "child-b.jsonl");
      try {
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(firstSession, "", "utf-8");
        fs.writeFileSync(secondSession, "", "utf-8");
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(
            {
              runId,
              mode: "parallel",
              state: "complete",
              startedAt: 100,
              lastUpdate: 200,
              cwd: tempDir,
              steps: [
                { agent: "a", status: "complete", sessionFile: firstSession },
                { agent: "b", status: "complete", sessionFile: secondSession },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

        const result = await executor.execute(
          "resume-revive-multi",
          { action: "resume", id: runId, index: 1, message: "What did b find?" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.match(result.content[0]?.text ?? "", /Revived async subagent from/);
        assert.match(result.content[0]?.text ?? "", /Agent: b/);
        assert.match(
          result.content[0]?.text ?? "",
          new RegExp(secondSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
        await waitForRevivedAsyncResult(result);
        const args = await readMockCallArgs(0);
        assert.equal(args[args.indexOf("--session") + 1], secondSession);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
    });

    it("resets runtime only for a successful selected child in a failed parallel revival", async () => {
      mockPi.onCall({ output: "revived successful child" });
      const runId = `resume-revive-mixed-results-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sourceResultPath = path.join(RESULTS_DIR, `${runId}.json`);
      const firstSession = path.join(tempDir, "child-a.jsonl");
      const secondSession = path.join(tempDir, "child-b.jsonl");
      let revivedId: string | undefined;
      try {
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(firstSession, "", "utf-8");
        fs.writeFileSync(secondSession, "", "utf-8");
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(
            {
              runId,
              mode: "parallel",
              state: "failed",
              startedAt: 100,
              endedAt: 200,
              lastUpdate: 200,
              cwd: tempDir,
              steps: [
                {
                  agent: "a",
                  status: "complete",
                  sessionFile: firstSession,
                  activeRuntimeMs: 6_000,
                },
                {
                  agent: "b",
                  status: "failed",
                  sessionFile: secondSession,
                  activeRuntimeMs: 6_000,
                },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );
        fs.writeFileSync(
          sourceResultPath,
          JSON.stringify(
            {
              id: runId,
              agent: "a",
              mode: "parallel",
              state: "failed",
              success: false,
              cwd: tempDir,
              results: [
                { agent: "a", success: true, sessionFile: firstSession, activeRuntimeMs: 6_000 },
                { agent: "b", success: false, sessionFile: secondSession, activeRuntimeMs: 6_000 },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor } = makeExecutor({
          agents: [
            makeAgent("a", { maxExecutionTimeMs: 5_000 }),
            makeAgent("b", { maxExecutionTimeMs: 5_000 }),
          ],
        });

        const successfulChild = await executor.execute(
          "resume-revive-mixed-success",
          { action: "resume", id: runId, index: 0, message: "Continue successful child a." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(successfulChild.isError, undefined, successfulChild.content[0]?.text ?? "");
        assert.equal(
          successfulChild.details?.asyncId ? typeof successfulChild.details.asyncId : undefined,
          "string",
        );
        revivedId = await waitForRevivedAsyncResult(successfulChild);
        const revivedStatus = readAsyncStatusJson<{
          steps?: Array<{ timeoutMs?: number }>;
        }>(revivedId);
        assert.equal(revivedStatus.steps?.[0]?.timeoutMs, 5_000);
        assert.equal(mockPi.callCount(), 1, "the successful selected child should launch");
        const revivedArgs = await readMockCallArgs(0);
        assert.equal(revivedArgs[revivedArgs.indexOf("--session") + 1], firstSession);

        const failedChild = await executor.execute(
          "resume-revive-mixed-failure",
          { action: "resume", id: runId, index: 1, message: "Continue failed child b." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(failedChild.isError, true);
        assert.match(
          failedChild.content[0]?.text ?? "",
          /Agent 'b' has exhausted its maxExecutionTimeMs ceiling after 6000ms of active runtime\./,
        );
        assert.equal(
          mockPi.callCount(),
          1,
          "the failed selected child should retain consumed runtime",
        );
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
        fs.rmSync(sourceResultPath, { force: true });
        if (revivedId) {
          fs.rmSync(path.join(ASYNC_DIR, revivedId), { recursive: true, force: true });
          fs.rmSync(path.join(RESULTS_DIR, `${revivedId}.json`), { force: true });
        }
      }
    });

    it("resume action revives paused async acceptance with paused-ledger provenance and monotonic overrides", async () => {
      mockPi.onCall({ delay: 10_000, output: "paused before acceptance" });
      mockPi.onCall({
        output: [
          "resume complete",
          "```acceptance-report",
          JSON.stringify({
            criteriaSatisfied: [
              {
                id: "criterion-1",
                status: "satisfied",
                evidence: "Implemented the requested fix after resume.",
              },
              {
                id: "criterion-2",
                status: "satisfied",
                evidence: "Included the requested resume note.",
              },
            ],
            changedFiles: ["src/example.ts"],
            testsAddedOrUpdated: ["test/integration/native-result-lifecycle.test.ts"],
            commandsRun: [
              { command: "npm test -- --runInBand", result: "passed", summary: "mocked" },
            ],
            validationOutput: [],
            residualRisks: ["none"],
            noStagedFiles: true,
            diffSummary: "resumed fix only",
            reviewFindings: ["no blockers"],
            manualNotes: "Resume note included.",
          }),
          "```",
        ].join("\n"),
      });
      const { executor } = makeExecutor();
      const started = await executor.execute(
        "resume-paused-acceptance-start",
        {
          agent: "worker",
          task: "Implement the paused acceptance fix",
          async: true,
          acceptance: {
            level: "checked",
            criteria: [
              { id: "criterion-1", must: "Implement the requested change without widening scope" },
            ],
            stopRules: ["Do not widen scope"],
          },
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      const asyncId = started.details?.asyncId;
      assert.ok(asyncId, "expected async id");
      const pausedResumeWaitMs = scaleTestTimeout(process.platform === "win32" ? 30_000 : 15_000);
      await waitForAsyncStatusPredicate(
        asyncId,
        (status) =>
          status.state === "running" &&
          status.steps?.[0]?.status === "running" &&
          !!(status.steps?.[0]?.sessionFile ?? status.sessionFile),
        "running child session",
        pausedResumeWaitMs,
      );
      await waitForMockPiCall(0);

      const interrupted = await executor.execute(
        "resume-paused-acceptance-interrupt",
        { action: "interrupt", id: asyncId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(interrupted.isError, undefined);
      await waitForAsyncStatusPredicate(
        asyncId,
        (status) =>
          status.state === "paused" &&
          status.steps?.[0]?.status === "paused" &&
          status.steps?.[0]?.acceptance?.status === "skipped" &&
          !!(status.steps?.[0]?.sessionFile ?? status.sessionFile),
        "paused skipped acceptance ledger",
        pausedResumeWaitMs,
      );
      // Resume immediately after the first paused status write, before the
      // results payload lands: the paused status itself must already carry the
      // skipped acceptance ledger so the revival keeps the original contract.
      const resumed = await executor.execute(
        "resume-paused-acceptance-resume",
        {
          action: "resume",
          id: asyncId,
          message: "Finish the fix and include the resume note.",
          acceptance: {
            level: "attested",
            criteria: [{ id: "criterion-2", must: "Include the requested resume note" }],
            evidence: ["manual-notes"],
          },
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(
        resumed.isError,
        undefined,
        `resume returned isError; text=${JSON.stringify(resumed.content?.[0]?.text)} details=${JSON.stringify(resumed.details)}`,
      );
      const revivedId = resumed.details?.asyncId;
      assert.ok(revivedId, "expected revived async id");
      await waitForFile(path.join(RESULTS_DIR, `${asyncId}.json`), pausedResumeWaitMs);
      const pausedPayload = JSON.parse(
        fs.readFileSync(path.join(RESULTS_DIR, `${asyncId}.json`), "utf-8"),
      ) as {
        results?: Array<{
          acceptance?: {
            status?: string;
            effectiveAcceptance?: { explicit?: boolean; level?: string; stopRules?: string[] };
          };
        }>;
      };
      assert.equal(pausedPayload.results?.[0]?.acceptance?.status, "skipped");
      assert.equal(pausedPayload.results?.[0]?.acceptance?.effectiveAcceptance?.explicit, true);
      assert.equal(pausedPayload.results?.[0]?.acceptance?.effectiveAcceptance?.level, "checked");
      await waitForFile(path.join(RESULTS_DIR, `${revivedId}.json`), pausedResumeWaitMs);
      const revivedPayload = JSON.parse(
        fs.readFileSync(path.join(RESULTS_DIR, `${revivedId}.json`), "utf-8"),
      ) as {
        results?: Array<{
          acceptance?: {
            status?: string;
            effectiveAcceptance?: {
              level?: string;
              explicit?: boolean;
              criteria?: Array<{ id?: string }>;
              evidence?: string[];
              stopRules?: string[];
            };
          };
        }>;
      };
      const revivedAcceptance = revivedPayload.results?.[0]?.acceptance?.effectiveAcceptance;
      assert.equal(revivedPayload.results?.[0]?.acceptance?.status, "checked");
      assert.equal(revivedAcceptance?.level, "checked");
      assert.equal(revivedAcceptance?.explicit, true);
      assert.deepEqual(
        revivedAcceptance?.criteria?.map((criterion) => criterion.id),
        ["criterion-1", "criterion-2"],
      );
      assert.equal(revivedAcceptance?.evidence?.includes("changed-files"), true);
      assert.equal(revivedAcceptance?.evidence?.includes("manual-notes"), true);
      assert.deepEqual(revivedAcceptance?.stopRules, ["Do not widen scope"]);
    });

    it("resume action revives a non-currentStep paused parallel child with its skipped acceptance contract intact", async () => {
      mockPi.onCall({ delay: 10_000, output: "parallel child a paused before acceptance" });
      mockPi.onCall({ delay: 10_000, output: "parallel child b paused before acceptance" });
      mockPi.onCall({
        output: [
          "parallel child a resumed",
          "```acceptance-report",
          JSON.stringify({
            criteriaSatisfied: [
              {
                id: "criterion-1",
                status: "satisfied",
                evidence: "Preserved the original paused contract.",
              },
              {
                id: "criterion-2",
                status: "satisfied",
                evidence: "Added the requested resume note.",
              },
            ],
            changedFiles: ["test/integration/native-result-lifecycle.test.ts"],
            testsAddedOrUpdated: ["test/integration/native-result-lifecycle.test.ts"],
            commandsRun: [
              { command: "npm test -- --runInBand", result: "passed", summary: "mocked" },
            ],
            validationOutput: [],
            residualRisks: ["none"],
            noStagedFiles: true,
            diffSummary: "resumed child only",
            reviewFindings: ["no blockers"],
            manualNotes: "Resume note included.",
          }),
          "```",
        ].join("\n"),
      });
      const { executor } = makeExecutor({
        agents: [makeAgent("a"), makeAgent("b")],
      });
      const started = await executor.execute(
        "resume-paused-parallel-acceptance-start",
        {
          tasks: [
            {
              agent: "a",
              task: "Implement child a changes",
              acceptance: {
                level: "checked",
                criteria: [
                  {
                    id: "criterion-1",
                    must: "Implement the requested change without widening scope",
                  },
                ],
                stopRules: ["Do not widen scope"],
              },
            },
            {
              agent: "b",
              task: "Implement child b changes",
              acceptance: {
                level: "checked",
                criteria: [
                  {
                    id: "criterion-1",
                    must: "Implement the requested change without widening scope",
                  },
                ],
                stopRules: ["Do not widen scope"],
              },
            },
          ],
          async: true,
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      const asyncId = started.details?.asyncId;
      assert.ok(asyncId, "expected async id");
      const pausedResumeWaitMs = scaleTestTimeout(process.platform === "win32" ? 30_000 : 15_000);
      await waitForAsyncStatusPredicate(
        asyncId,
        (status) =>
          status.state === "running" &&
          status.currentStep === 1 &&
          status.steps?.[0]?.status === "running" &&
          status.steps?.[1]?.status === "running",
        "running parallel children with last-started currentStep",
        pausedResumeWaitMs,
      );
      const runningStatus = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, asyncId, "status.json"), "utf-8"),
      ) as {
        currentStep?: number;
        steps?: Array<{ acceptance?: { status?: string } }>;
      };
      assert.equal(runningStatus.currentStep, 1);
      assert.equal(runningStatus.steps?.[0]?.acceptance, undefined);
      assert.equal(runningStatus.steps?.[1]?.acceptance, undefined);
      await waitForMockPiCall(1);

      const interrupted = await executor.execute(
        "resume-paused-parallel-acceptance-interrupt",
        { action: "interrupt", id: asyncId },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(interrupted.isError, undefined);
      await waitForAsyncStatusPredicate(
        asyncId,
        (status) =>
          status.state === "paused" &&
          status.steps?.[0]?.status === "paused" &&
          status.steps?.[1]?.status === "paused" &&
          status.steps?.[0]?.acceptance?.status === "skipped" &&
          status.steps?.[1]?.acceptance?.status === "skipped",
        "paused parallel skipped acceptance ledgers",
        pausedResumeWaitMs,
      );
      const pausedStatus = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, asyncId, "status.json"), "utf-8"),
      ) as {
        steps?: Array<{
          acceptance?: {
            status?: string;
            effectiveAcceptance?: {
              explicit?: boolean;
              level?: string;
              criteria?: Array<{ id?: string }>;
              stopRules?: string[];
            };
          };
        }>;
      };
      const pausedNonCurrentAcceptance = pausedStatus.steps?.[0]?.acceptance;
      assert.equal(pausedNonCurrentAcceptance?.status, "skipped");
      assert.equal(pausedNonCurrentAcceptance?.effectiveAcceptance?.explicit, true);
      assert.equal(pausedNonCurrentAcceptance?.effectiveAcceptance?.level, "checked");
      assert.deepEqual(
        pausedNonCurrentAcceptance?.effectiveAcceptance?.criteria?.map((criterion) => criterion.id),
        ["criterion-1"],
      );
      assert.deepEqual(pausedNonCurrentAcceptance?.effectiveAcceptance?.stopRules, [
        "Do not widen scope",
      ]);

      const resumed = await executor.execute(
        "resume-paused-parallel-acceptance-resume",
        {
          action: "resume",
          id: asyncId,
          index: 0,
          message: "Finish child a and include the resume note.",
          acceptance: {
            level: "attested",
            criteria: [{ id: "criterion-2", must: "Include the requested resume note" }],
            evidence: ["manual-notes"],
          },
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(
        resumed.isError,
        undefined,
        `resume returned isError; text=${JSON.stringify(resumed.content?.[0]?.text)} details=${JSON.stringify(resumed.details)}`,
      );
      const revivedId = resumed.details?.asyncId;
      assert.ok(revivedId, "expected revived async id");
      await waitForFile(path.join(RESULTS_DIR, `${revivedId}.json`), pausedResumeWaitMs);
      const revivedPayload = JSON.parse(
        fs.readFileSync(path.join(RESULTS_DIR, `${revivedId}.json`), "utf-8"),
      ) as {
        results?: Array<{
          acceptance?: {
            status?: string;
            effectiveAcceptance?: {
              level?: string;
              explicit?: boolean;
              criteria?: Array<{ id?: string }>;
              evidence?: string[];
              stopRules?: string[];
            };
          };
        }>;
      };
      const revivedAcceptance = revivedPayload.results?.[0]?.acceptance?.effectiveAcceptance;
      assert.equal(revivedPayload.results?.[0]?.acceptance?.status, "checked");
      assert.equal(revivedAcceptance?.level, "checked");
      assert.equal(revivedAcceptance?.explicit, true);
      assert.deepEqual(
        revivedAcceptance?.criteria?.map((criterion) => criterion.id),
        ["criterion-1", "criterion-2"],
      );
      assert.equal(revivedAcceptance?.evidence?.includes("changed-files"), true);
      assert.equal(revivedAcceptance?.evidence?.includes("manual-notes"), true);
      assert.deepEqual(revivedAcceptance?.stopRules, ["Do not widen scope"]);
    });

    it("resume action revives completed async runs with concise status receipts", async () => {
      mockPi.onCall({ output: "revived answer" });
      const runId = `resume-revive-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sessionFile = path.join(tempDir, "child-session.jsonl");
      try {
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(sessionFile, "", "utf-8");
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
              sessionFile,
              steps: [{ agent: "worker", status: "complete" }],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor } = makeExecutor();

        const result = await executor.execute(
          "resume-revive",
          { action: "resume", id: runId, message: "What changed?" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.match(result.content[0]?.text ?? "", /Revived async subagent from/);
        assert.match(
          result.content[0]?.text ?? "",
          /Status if needed: subagent\(\{ action: "status"/,
        );
        assert.doesNotMatch(
          result.content[0]?.text ?? "",
          /Do not run sleep timers or polling loops/,
        );
        assert.doesNotMatch(result.content[0]?.text ?? "", /call wait\(\)/);
        assert.doesNotMatch(result.content[0]?.text ?? "", /Follow:/);
        const revivedId = result.details?.asyncId;
        assert.ok(revivedId, "expected revived async id");
        const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(resultPath)) {
          if (Date.now() > deadline)
            assert.fail(`Timed out waiting for revived result file: ${resultPath}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
    });

    it("resume of a completed foreground child tolerates missing lifecycle status without mutation", async () => {
      mockPi.onCall({ output: "revived from remembered foreground state" });
      const runId = `resume-foreground-missing-status-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      const { executor, state } = makeExecutor();
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      state.foregroundRuns.set(runId, {
        runId,
        mode: "single",
        cwd: tempDir,
        updatedAt: 1,
        children: [{ agent: "worker", index: 0, status: "completed", sessionFile }],
      });
      try {
        const result = await executor.execute(
          "resume-foreground-missing-status",
          { action: "resume", id: runId, message: "Continue the completed child." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
        await waitForRevivedAsyncResult(result);
        assert.deepEqual(fs.readdirSync(asyncDir), []);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
        fs.rmSync(sessionFile, { force: true });
      }
    });

    it("resume of a paused foreground child rejects missing lifecycle status without mutation", async () => {
      const runId = `resume-foreground-paused-missing-status-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      const { executor, state } = makeExecutor();
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      state.foregroundRuns.set(runId, {
        runId,
        mode: "single",
        cwd: tempDir,
        updatedAt: 1,
        children: [
          {
            agent: "worker",
            index: 0,
            status: "paused",
            sessionFile,
            pause: { kind: "awaiting_supervisor" },
          },
        ],
      });
      try {
        const result = await executor.execute(
          "resume-foreground-paused-missing-status",
          { action: "resume", id: runId },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /Paused run .* was not found/);
        assert.deepEqual(fs.readdirSync(asyncDir), []);
        assert.equal(mockPi.callCount(), 0);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
        fs.rmSync(sessionFile, { force: true });
      }
    });

    it("resume of a completed result-only background run does not recreate its missing lifecycle directory", async () => {
      mockPi.onCall({ output: "revived from result-only background state" });
      const runId = `resume-background-result-only-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const resultPath = path.join(RESULTS_DIR, `${runId}.json`);
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: runId,
          agent: "worker",
          success: true,
          state: "complete",
          cwd: tempDir,
          results: [{ agent: "worker", success: true, sessionFile }],
        }),
        "utf-8",
      );
      try {
        assert.equal(fs.existsSync(asyncDir), false);
        assert.equal(fs.existsSync(resultPath), true);
        const { executor } = makeExecutor();
        // Explicit `dir` preserves the missing lifecycle path on the target;
        // id-only result lookup would normalize asyncDir to null and skip the guard.
        const result = await executor.execute(
          "resume-background-result-only",
          {
            action: "resume",
            id: runId,
            dir: asyncDir,
            message: "Continue from the saved result.",
          },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
        await waitForRevivedAsyncResult(result);
        assert.equal(fs.existsSync(asyncDir), false);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
        fs.rmSync(resultPath, { force: true });
        fs.rmSync(sessionFile, { force: true });
      }
    });

    it("resumes a completed nested result when its lifecycle status is missing without recreating the directory", async () => {
      mockPi.onCall({ output: "revived from nested result" });
      const runId = `nested-result-missing-status-${Date.now()}`;
      const route = createNestedRoute(`nested-root-${Date.now()}`);
      const nestedAsyncDir = path.join(
        resolveTempRootDir(),
        "nested-subagent-runs",
        route.rootRunId,
        runId,
      );
      const sessionFile = path.join(tempDir, runId, "run-0", "session.jsonl");
      const parentSessionFile = path.join(tempDir, "parent.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.mkdirSync(path.dirname(nestedAsyncDir), { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(parentSessionFile, "", "utf-8");
      writeNestedEvent(route, {
        type: "subagent.nested.completed",
        ts: Date.now(),
        parentRunId: route.rootRunId,
        parentStepIndex: 0,
        child: {
          id: runId,
          parentRunId: route.rootRunId,
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: route.rootRunId, stepIndex: 0 }],
          state: "complete",
          agent: "worker",
          ownerState: "gone",
          asyncDir: nestedAsyncDir,
          sessionFile,
        },
      });
      const { executor, state } = makeExecutor();
      state.foregroundControls.set(route.rootRunId, {
        runId: route.rootRunId,
        mode: "single",
        startedAt: 1,
        updatedAt: 1,
        nestedRoute: route,
      });
      state.lastForegroundControlId = route.rootRunId;
      try {
        const context = makeMinimalCtx(tempDir);
        context.sessionManager.getSessionFile = () => parentSessionFile;
        const result = await executor.execute(
          "resume-nested-result-missing-status",
          { action: "resume", id: runId, message: "Continue the nested child." },
          new AbortController().signal,
          undefined,
          context,
        );

        assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
        await waitForRevivedAsyncResult(result);
        assert.equal(fs.existsSync(nestedAsyncDir), false);
      } finally {
        fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
        fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
        fs.rmSync(parentSessionFile, { force: true });
        fs.rmSync(path.dirname(sessionFile), { recursive: true, force: true });
      }
    });

    it("rejects a paused nested result when its lifecycle status is missing without recreating the directory", async () => {
      const runId = `nested-paused-missing-status-${Date.now()}`;
      const route = createNestedRoute(`nested-root-${Date.now()}`);
      const nestedAsyncDir = path.join(
        resolveTempRootDir(),
        "nested-subagent-runs",
        route.rootRunId,
        runId,
      );
      const sessionFile = path.join(tempDir, runId, "run-0", "session.jsonl");
      const parentSessionFile = path.join(tempDir, "parent.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.mkdirSync(path.dirname(nestedAsyncDir), { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(parentSessionFile, "", "utf-8");
      writeNestedEvent(route, {
        type: "subagent.nested.completed",
        ts: Date.now(),
        parentRunId: route.rootRunId,
        parentStepIndex: 0,
        child: {
          id: runId,
          parentRunId: route.rootRunId,
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: route.rootRunId, stepIndex: 0 }],
          state: "paused",
          agent: "worker",
          ownerState: "gone",
          asyncDir: nestedAsyncDir,
          sessionFile,
        },
      });
      const { executor, state } = makeExecutor();
      state.foregroundControls.set(route.rootRunId, {
        runId: route.rootRunId,
        mode: "single",
        startedAt: 1,
        updatedAt: 1,
        nestedRoute: route,
      });
      state.lastForegroundControlId = route.rootRunId;
      try {
        const context = makeMinimalCtx(tempDir);
        context.sessionManager.getSessionFile = () => parentSessionFile;
        const result = await executor.execute(
          "resume-nested-paused-missing-status",
          { action: "resume", id: runId, message: "Continue the paused nested child." },
          new AbortController().signal,
          undefined,
          context,
        );

        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /skipped acceptance ledger could not be read/);
        assert.equal(fs.existsSync(nestedAsyncDir), false);
        assert.equal(mockPi.callCount(), 0);
      } finally {
        fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
        fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
        fs.rmSync(parentSessionFile, { force: true });
        fs.rmSync(path.dirname(sessionFile), { recursive: true, force: true });
      }
    });

    it("resume action revives a completed foreground child by index", async () => {
      mockPi.onCall({ output: "first child done" });
      mockPi.onCall({ output: "second child done" });
      mockPi.onCall({ output: "revived foreground answer" });
      const { executor } = makeExecutor({
        agents: [makeAgent("a"), makeAgent("b")],
      });

      const original = await executor.execute(
        "foreground-resume-original",
        {
          tasks: [
            { agent: "a", task: "task-a" },
            { agent: "b", task: "task-b" },
          ],
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      const runId = original.details?.runId;
      assert.ok(runId, "expected foreground run id");

      const revived = await executor.execute(
        "foreground-resume",
        { action: "resume", id: runId, index: 1, message: "Follow up with b" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(revived.isError, undefined);
      assert.match(revived.content[0]?.text ?? "", /Revived foreground subagent from/);
      assert.match(revived.content[0]?.text ?? "", /Agent: b/);
      const reviveArgs = await readMockCallArgs(2);
      const selectedSession = original.details?.results?.[1]?.sessionFile;
      assert.ok(selectedSession, "expected selected child session file");
      assert.equal(reviveArgs[reviveArgs.indexOf("--session") + 1], selectedSession);
      const revivedId = revived.details?.asyncId;
      assert.ok(revivedId, "expected revived async id");
      const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(resultPath)) {
        if (Date.now() > deadline)
          assert.fail(`Timed out waiting for revived result file: ${resultPath}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
  },
);
