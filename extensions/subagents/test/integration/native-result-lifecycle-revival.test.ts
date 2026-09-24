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
  waitForRevivedAsyncResult,
  type NativeExecutorOptions,
} from "../support/native-result-lifecycle-fixtures.ts";

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

    it("gives each selected child of a failed run a fresh resume deadline", async () => {
      mockPi.onCall({ output: "revived successful child" });
      mockPi.onCall({ output: "revived failed child" });
      const runId = `resume-revive-mixed-results-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sourceResultPath = path.join(RESULTS_DIR, `${runId}.json`);
      const firstSession = path.join(tempDir, "child-a.jsonl");
      const secondSession = path.join(tempDir, "child-b.jsonl");
      const revivedIds: string[] = [];
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
                { agent: "a", status: "complete", sessionFile: firstSession },
                { agent: "b", status: "failed", sessionFile: secondSession },
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
                { agent: "a", success: true, sessionFile: firstSession },
                { agent: "b", success: false, sessionFile: secondSession },
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
        const successfulId = await waitForRevivedAsyncResult(successfulChild);
        revivedIds.push(successfulId);
        const successfulStatus = readAsyncStatusJson<{
          steps?: Array<{ timeoutMs?: number; deadlineAt?: number; startedAt?: number }>;
        }>(successfulId);
        assert.equal(successfulStatus.steps?.[0]?.timeoutMs, 5_000);
        assert.equal(
          successfulStatus.steps?.[0]?.deadlineAt,
          (successfulStatus.steps?.[0]?.startedAt ?? 0) + 5_000,
        );
        assert.equal(mockPi.callCount(), 1, "the successful selected child should launch");
        const successfulArgs = await readMockCallArgs(0);
        assert.equal(successfulArgs[successfulArgs.indexOf("--session") + 1], firstSession);

        const failedChild = await executor.execute(
          "resume-revive-mixed-failure",
          { action: "resume", id: runId, index: 1, message: "Continue failed child b." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(failedChild.isError, undefined, failedChild.content[0]?.text ?? "");
        const failedId = await waitForRevivedAsyncResult(failedChild);
        revivedIds.push(failedId);
        const failedStatus = readAsyncStatusJson<{
          steps?: Array<{ timeoutMs?: number; deadlineAt?: number; startedAt?: number }>;
        }>(failedId);
        assert.equal(failedStatus.steps?.[0]?.timeoutMs, 5_000);
        assert.equal(
          failedStatus.steps?.[0]?.deadlineAt,
          (failedStatus.steps?.[0]?.startedAt ?? 0) + 5_000,
        );
        assert.equal(mockPi.callCount(), 2, "the failed selected child should also launch");
        const failedArgs = await readMockCallArgs(1);
        assert.equal(failedArgs[failedArgs.indexOf("--session") + 1], secondSession);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
        fs.rmSync(sourceResultPath, { force: true });
        for (const revivedId of revivedIds) {
          fs.rmSync(path.join(ASYNC_DIR, revivedId), { recursive: true, force: true });
          fs.rmSync(path.join(RESULTS_DIR, `${revivedId}.json`), { force: true });
        }
      }
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

    it("resume action preserves independent same-segment pressure diagnostics", async () => {
      const contextUsage = { contextTokens: 400, contextWindow: 1_000 };
      const contextPressure = {
        severity: "warning" as const,
        crossedThreshold: "warning" as const,
        contextTokens: 850,
        contextWindow: 1_000,
        contextPercent: 85,
        remainingTokens: 150,
        warnedAt: 123,
      };
      const contextPressureCrossedThresholds = ["warning", "critical"] as const;
      const cases = [
        { label: "pressure-only", contextPressure },
        { label: "history-only", contextPressureCrossedThresholds },
        { label: "both", contextPressure, contextPressureCrossedThresholds },
        { label: "neither" },
      ] as const;

      // Public target normalization drops present-but-undefined diagnostic fields before this
      // seam; there is no public hook that can distinguish that case, so it is not fabricated.
      for (const currentCase of cases) {
        const runId = `resume-pressure-${currentCase.label}-${Date.now().toString(36)}`;
        const sessionFile = path.join(tempDir, `${runId}.jsonl`);
        const asyncDir = path.join(ASYNC_DIR, runId);
        const { executor } = makeExecutor();
        let revivedId: string | undefined;
        fs.writeFileSync(sessionFile, "", "utf-8");
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(
            {
              runId,
              mode: "single",
              state: "complete",
              startedAt: 1,
              lastUpdate: 1,
              cwd: tempDir,
              sessionFile,
              steps: [
                {
                  agent: "worker",
                  status: "complete",
                  sessionFile,
                  contextUsage,
                  ...("contextPressure" in currentCase
                    ? { contextPressure: currentCase.contextPressure }
                    : {}),
                  ...("contextPressureCrossedThresholds" in currentCase
                    ? {
                        contextPressureCrossedThresholds:
                          currentCase.contextPressureCrossedThresholds,
                      }
                    : {}),
                },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );
        mockPi.onCall({ output: `revived ${currentCase.label}` });
        try {
          const result = await executor.execute(
            `resume-pressure-${currentCase.label}`,
            { action: "resume", id: runId, message: "Continue the diagnostic check." },
            new AbortController().signal,
            undefined,
            makeMinimalCtx(tempDir),
          );

          assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
          revivedId = await waitForRevivedAsyncResult(result);
          const status = readAsyncStatusJson<{
            steps?: Array<{
              contextUsage?: { contextTokens?: number; contextWindow?: number };
              contextPressure?: typeof contextPressure;
              contextPressureCrossedThresholds?: string[];
            }>;
          }>(revivedId);
          const step = status.steps?.[0];
          const expectedPressure =
            "contextPressure" in currentCase ? currentCase.contextPressure : undefined;
          const expectedHistory =
            "contextPressureCrossedThresholds" in currentCase
              ? currentCase.contextPressureCrossedThresholds
              : undefined;
          assert.equal(
            Object.hasOwn(step ?? {}, "contextPressure"),
            expectedPressure !== undefined,
          );
          assert.equal(
            Object.hasOwn(step ?? {}, "contextPressureCrossedThresholds"),
            expectedHistory !== undefined,
          );
          assert.deepEqual(step?.contextPressure, expectedPressure);
          assert.deepEqual(step?.contextPressureCrossedThresholds, expectedHistory);
          assert.equal(Object.hasOwn(step ?? {}, "contextUsage"), true);
        } finally {
          if (revivedId) {
            fs.rmSync(path.join(ASYNC_DIR, revivedId), { recursive: true, force: true });
            fs.rmSync(path.join(RESULTS_DIR, `${revivedId}.json`), { force: true });
          }
          fs.rmSync(asyncDir, { recursive: true, force: true });
          fs.rmSync(sessionFile, { force: true });
        }
      }
    });

    it("resume action clears both pressure diagnostics for a claimed paused continuation", async () => {
      const runId = `resume-pressure-claimed-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      const contextUsage = { contextTokens: 400, contextWindow: 1_000 };
      const contextPressure = {
        severity: "warning" as const,
        crossedThreshold: "warning" as const,
        contextTokens: 850,
        contextWindow: 1_000,
        contextPercent: 85,
        remainingTokens: 150,
        warnedAt: 123,
      };
      const contextPressureCrossedThresholds = ["warning", "critical"] as const;
      let revivedId: string | undefined;
      try {
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(sessionFile, "", "utf-8");
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(
            {
              runId,
              mode: "single",
              state: "paused",
              startedAt: 100,
              lastUpdate: 200,
              cwd: tempDir,
              sessionFile,
              pause: { kind: "awaiting_supervisor" },
              steps: [
                {
                  agent: "worker",
                  status: "paused",
                  sessionFile,
                  pause: { kind: "awaiting_supervisor" },
                  contextUsage,
                  contextPressure,
                  contextPressureCrossedThresholds,
                },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor } = makeExecutor();
        mockPi.onCall({ output: "revived claimed continuation" });

        const result = await executor.execute(
          "resume-pressure-claimed",
          { action: "resume", id: runId, message: "Continue the claimed diagnostic check." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
        revivedId = await waitForRevivedAsyncResult(result);
        const status = readAsyncStatusJson<{
          steps?: Array<{
            contextUsage?: { contextTokens?: number; contextWindow?: number };
            contextPressure?: unknown;
            contextPressureCrossedThresholds?: unknown;
          }>;
        }>(revivedId);
        const step = status.steps?.[0];
        assert.equal(Object.hasOwn(step ?? {}, "contextPressure"), false);
        assert.equal(Object.hasOwn(step ?? {}, "contextPressureCrossedThresholds"), false);
        assert.equal(step?.contextPressure, undefined);
        assert.equal(step?.contextPressureCrossedThresholds, undefined);
        assert.equal(Object.hasOwn(step ?? {}, "contextUsage"), true);
      } finally {
        if (revivedId) {
          fs.rmSync(path.join(ASYNC_DIR, revivedId), { recursive: true, force: true });
          fs.rmSync(path.join(RESULTS_DIR, `${revivedId}.json`), { force: true });
        }
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
      state.asyncJobs.set(route.rootRunId, {
        asyncId: route.rootRunId,
        asyncDir: path.dirname(nestedAsyncDir),
        status: "running",
        mode: "single",
        nestedRoute: route,
      });
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
      state.asyncJobs.set(route.rootRunId, {
        asyncId: route.rootRunId,
        asyncDir: path.dirname(nestedAsyncDir),
        status: "running",
        mode: "single",
        nestedRoute: route,
      });
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
        assert.match(result.content[0]?.text ?? "", /session file does not exist|status/i);
        assert.equal(fs.existsSync(nestedAsyncDir), false);
        assert.equal(mockPi.callCount(), 0);
      } finally {
        fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
        fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
        fs.rmSync(parentSessionFile, { force: true });
        fs.rmSync(path.dirname(sessionFile), { recursive: true, force: true });
      }
    });

    it("resume action revives a completed awaited child by index", async () => {
      mockPi.onCall({ output: "first child done" });
      mockPi.onCall({ output: "second child done" });
      mockPi.onCall({ output: "revived awaited answer" });
      const { executor } = makeExecutor({
        agents: [makeAgent("a"), makeAgent("b")],
      });

      const original = await executor.execute(
        "awaited-resume-original",
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
      assert.ok(runId, "expected awaited run id");

      const revived = await executor.execute(
        "awaited-resume",
        { action: "resume", id: runId, index: 1, message: "Follow up with b" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(revived.isError, undefined);
      assert.match(revived.content[0]?.text ?? "", /Revived async subagent from/);
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
