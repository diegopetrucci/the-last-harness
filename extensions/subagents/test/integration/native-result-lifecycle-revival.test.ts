/** Completed-run revival and exact-id recovery coverage. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR, RESULTS_DIR, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";
import {
  consumeChildMessageRequests,
  steerRequestsDir,
  writeChildMessageAcceptance,
} from "../../src/runs/background/control-channel.ts";
import {
  buildSkippedAcceptanceLedger,
  resolveEffectiveAcceptance,
} from "../../src/runs/shared/acceptance.ts";
import { getArtifactsDir } from "../../src/shared/artifacts.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
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
import { waitForAsyncResultFile } from "../support/async-execution-helpers.ts";

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

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    function requireRecord(value: unknown, label: string): Record<string, unknown> {
      if (!isRecord(value)) throw new Error(`${label} must be an object.`);
      return value;
    }

    function requireRecordArray(value: unknown, label: string): Record<string, unknown>[] {
      if (!Array.isArray(value) || !value.every(isRecord))
        throw new Error(`${label} must be an array of objects.`);
      return value;
    }

    function requireStringArray(value: unknown, label: string): string[] {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
        throw new Error(`${label} must be an array of strings.`);
      return value;
    }

    function readResultAcceptance(value: unknown): {
      status: unknown;
      effectiveAcceptance: Record<string, unknown>;
    } {
      const payload = requireRecord(value, "result payload");
      const results = requireRecordArray(payload.results, "result payload.results");
      const result = results[0];
      if (!result) throw new Error("result payload.results must contain an entry.");
      const acceptance = requireRecord(result.acceptance, "result acceptance");
      return {
        status: acceptance.status,
        effectiveAcceptance: requireRecord(
          acceptance.effectiveAcceptance,
          "result effective acceptance",
        ),
      };
    }

    function pausedAcceptanceLedger() {
      return buildSkippedAcceptanceLedger({
        acceptance: resolveEffectiveAcceptance({
          agentName: "worker",
          task: "Resume the paused child.",
          mode: "single",
        }),
        ledgerStatus: "skipped",
        runtimeCheckStatus: "not-applicable",
        id: "paused",
        message: "Acceptance will run after resume.",
      });
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

    it("rejects a persisted role-timeout poison record despite a raised limit", async () => {
      const runId = `resume-poisoned-role-timeout-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const statusPath = path.join(asyncDir, "status.json");
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        statusPath,
        JSON.stringify(
          {
            runId,
            mode: "single",
            state: "failed",
            startedAt: 100,
            endedAt: 200,
            lastUpdate: 200,
            cwd: tempDir,
            steps: [
              {
                agent: "worker",
                status: "failed",
                sessionFile,
                timedOut: true,
                timeoutOwner: "role",
                timeoutMs: 200,
                activeRuntimeMs: 100,
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const beforeStatus = fs.readFileSync(statusPath);
      const beforeSession = fs.readFileSync(sessionFile);
      try {
        const { executor } = makeExecutor({
          agents: [makeAgent("worker", { maxExecutionTimeMs: 1_000 })],
        });
        const result = await executor.execute(
          "resume-poisoned-role-timeout",
          { action: "resume", id: runId, message: "Continue after raising the limit." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.equal(
          result.content[0]?.text,
          "Agent 'worker' has exhausted its maxExecutionTimeMs ceiling; persisted role-timeout evidence permanently retires this instance.",
        );
        assert.equal(mockPi.callCount(), 0);
        assert.deepEqual(fs.readFileSync(statusPath), beforeStatus);
        assert.deepEqual(fs.readFileSync(sessionFile), beforeSession);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
        fs.rmSync(sessionFile, { force: true });
      }
    });

    it("does not poison run-owned or ownerless legacy timeout records with runtime remaining", async () => {
      const cases: Array<{ label: string; timeoutOwner?: "run" }> = [
        { label: "run-owned", timeoutOwner: "run" },
        { label: "ownerless" },
      ];
      for (const [index, currentCase] of cases.entries()) {
        const runId = `resume-legacy-timeout-${currentCase.label}-${Date.now()}`;
        const asyncDir = path.join(ASYNC_DIR, runId);
        const statusPath = path.join(asyncDir, "status.json");
        const sessionFile = path.join(tempDir, `${runId}.jsonl`);
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(sessionFile, "", "utf-8");
        fs.writeFileSync(
          statusPath,
          JSON.stringify(
            {
              runId,
              mode: "single",
              state: "failed",
              startedAt: 100,
              endedAt: 200,
              lastUpdate: 200,
              cwd: tempDir,
              steps: [
                {
                  agent: "worker",
                  status: "failed",
                  sessionFile,
                  timedOut: true,
                  ...(currentCase.timeoutOwner ? { timeoutOwner: currentCase.timeoutOwner } : {}),
                  activeRuntimeMs: 100,
                },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );
        let revivedId: string | undefined;
        try {
          mockPi.onCall({ output: `${currentCase.label} legacy timeout resumed` });
          const { executor } = makeExecutor({
            agents: [makeAgent("worker", { maxExecutionTimeMs: 1_000 })],
          });
          const result = await executor.execute(
            `resume-${currentCase.label}`,
            { action: "resume", id: runId, message: "Continue with runtime remaining." },
            new AbortController().signal,
            undefined,
            makeMinimalCtx(tempDir),
          );

          assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
          revivedId = await waitForRevivedAsyncResult(result);
          assert.equal(mockPi.callCount(), index + 1);
        } finally {
          fs.rmSync(asyncDir, { recursive: true, force: true });
          if (revivedId) {
            fs.rmSync(path.join(ASYNC_DIR, revivedId), { recursive: true, force: true });
            fs.rmSync(path.join(RESULTS_DIR, `${revivedId}.json`), { force: true });
          }
          fs.rmSync(sessionFile, { force: true });
        }
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

    it("retains runtime for every selected child in a failed parallel revival", async () => {
      const runId = `resume-revive-mixed-results-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sourceResultPath = path.join(RESULTS_DIR, `${runId}.json`);
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
        assert.equal(successfulChild.isError, true);
        assert.match(
          successfulChild.content[0]?.text ?? "",
          /Agent 'a' has exhausted its maxExecutionTimeMs ceiling after 6000ms of active runtime\./,
        );
        assert.equal(mockPi.callCount(), 0, "the successful selected child must not relaunch");

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
        assert.equal(mockPi.callCount(), 0, "the failed selected child must not relaunch");
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
        fs.rmSync(sourceResultPath, { force: true });
      }
    });

    it("only poisons the exhausted sibling in a mixed parallel revival", async () => {
      const runId = `resume-poisoned-parallel-sibling-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const statusPath = path.join(asyncDir, "status.json");
      const poisonedSession = path.join(tempDir, `${runId}-poisoned.jsonl`);
      const healthySession = path.join(tempDir, `${runId}-healthy.jsonl`);
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(poisonedSession, "poisoned session", "utf-8");
      fs.writeFileSync(healthySession, "healthy session", "utf-8");
      fs.writeFileSync(
        statusPath,
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
                agent: "poisoned",
                status: "failed",
                sessionFile: poisonedSession,
                timedOut: true,
                timeoutOwner: "role",
                activeRuntimeMs: 100,
              },
              {
                agent: "healthy",
                status: "complete",
                sessionFile: healthySession,
                activeRuntimeMs: 100,
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const beforeStatus = fs.readFileSync(statusPath);
      const beforePoisonedSession = fs.readFileSync(poisonedSession);
      const beforeHealthySession = fs.readFileSync(healthySession);
      let revivedId: string | undefined;
      try {
        const { executor } = makeExecutor({
          agents: [
            makeAgent("poisoned", { maxExecutionTimeMs: 1_000 }),
            makeAgent("healthy", { maxExecutionTimeMs: 1_000 }),
          ],
        });
        const blocked = await executor.execute(
          "resume-poisoned-parallel-sibling",
          { action: "resume", id: runId, index: 0, message: "Continue the poisoned child." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(blocked.isError, true);
        assert.equal(
          blocked.content[0]?.text,
          "Agent 'poisoned' has exhausted its maxExecutionTimeMs ceiling; persisted role-timeout evidence permanently retires this instance.",
        );
        assert.equal(mockPi.callCount(), 0);
        assert.deepEqual(fs.readFileSync(statusPath), beforeStatus);
        assert.deepEqual(fs.readFileSync(poisonedSession), beforePoisonedSession);
        assert.deepEqual(fs.readFileSync(healthySession), beforeHealthySession);

        mockPi.onCall({ output: "healthy sibling resumed" });
        const resumed = await executor.execute(
          "resume-healthy-parallel-sibling",
          { action: "resume", id: runId, index: 1, message: "Continue the healthy child." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(resumed.isError, undefined, resumed.content[0]?.text ?? "");
        revivedId = await waitForRevivedAsyncResult(resumed);
        assert.equal(mockPi.callCount(), 1);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
        if (revivedId) {
          fs.rmSync(path.join(ASYNC_DIR, revivedId), { recursive: true, force: true });
          fs.rmSync(path.join(RESULTS_DIR, `${revivedId}.json`), { force: true });
        }
        fs.rmSync(poisonedSession, { force: true });
        fs.rmSync(healthySession, { force: true });
      }
    });

    it("preserves paused-ledger provenance despite read-only resume wording", async () => {
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
                evidence: "Preserved the inferred checked contract after the read-only resume.",
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
          message: "Inspect the result and summarize the resume note, read-only.",
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
      const pausedPayload: unknown = JSON.parse(
        fs.readFileSync(path.join(RESULTS_DIR, `${asyncId}.json`), "utf-8"),
      );
      const pausedAcceptance = readResultAcceptance(pausedPayload);
      const pausedEffectiveAcceptance = pausedAcceptance.effectiveAcceptance;
      assert.equal(pausedAcceptance.status, "skipped");
      assert.equal(pausedEffectiveAcceptance.explicit, false);
      assert.equal(pausedEffectiveAcceptance.level, "checked");
      assert.deepEqual(pausedEffectiveAcceptance.inferredReason, [
        "async write-capable or risky run",
      ]);
      assert.deepEqual(
        requireRecordArray(pausedEffectiveAcceptance.criteria, "paused acceptance criteria").map(
          (criterion) => criterion.id,
        ),
        ["criterion-1"],
      );
      assert.ok(
        requireStringArray(
          pausedEffectiveAcceptance.evidence,
          "paused acceptance evidence",
        ).includes("changed-files"),
      );
      assert.deepEqual(
        requireStringArray(pausedEffectiveAcceptance.stopRules, "paused stop rules"),
        [],
      );
      await waitForFile(path.join(RESULTS_DIR, `${revivedId}.json`), pausedResumeWaitMs);
      const revivedPayload: unknown = JSON.parse(
        fs.readFileSync(path.join(RESULTS_DIR, `${revivedId}.json`), "utf-8"),
      );
      const revivedAcceptance = readResultAcceptance(revivedPayload);
      assert.equal(revivedAcceptance.status, "checked");
      assert.deepEqual(revivedAcceptance.effectiveAcceptance, pausedEffectiveAcceptance);
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
                evidence: "Preserved the inferred checked contract after the read-only resume.",
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
            { agent: "a", task: "Implement child a changes" },
            { agent: "b", task: "Implement child b changes" },
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
      const runningStatus: unknown = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, asyncId, "status.json"), "utf-8"),
      );
      const runningRecord = requireRecord(runningStatus, "running status");
      assert.equal(runningRecord.currentStep, 1);
      const runningSteps = requireRecordArray(runningRecord.steps, "running status steps");
      assert.equal(runningSteps[0]?.acceptance, undefined);
      assert.equal(runningSteps[1]?.acceptance, undefined);
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
      const pausedStatus: unknown = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, asyncId, "status.json"), "utf-8"),
      );
      const pausedRecord = requireRecord(pausedStatus, "paused status");
      const pausedSteps = requireRecordArray(pausedRecord.steps, "paused status steps");
      const pausedNonCurrentAcceptance = readResultAcceptance({
        results: [{ acceptance: pausedSteps[0]?.acceptance }],
      });
      const pausedCurrentAcceptance = readResultAcceptance({
        results: [{ acceptance: pausedSteps[1]?.acceptance }],
      });
      assert.equal(pausedNonCurrentAcceptance.status, "skipped");
      assert.equal(pausedCurrentAcceptance.status, "skipped");
      const pausedEffectiveAcceptance = pausedNonCurrentAcceptance.effectiveAcceptance;
      assert.equal(pausedEffectiveAcceptance.explicit, false);
      assert.equal(pausedEffectiveAcceptance.level, "checked");
      assert.deepEqual(pausedEffectiveAcceptance.inferredReason, [
        "async write-capable or risky run",
      ]);
      assert.deepEqual(
        requireRecordArray(pausedEffectiveAcceptance.criteria, "paused acceptance criteria").map(
          (criterion) => criterion.id,
        ),
        ["criterion-1"],
      );
      assert.ok(
        requireStringArray(
          pausedEffectiveAcceptance.evidence,
          "paused acceptance evidence",
        ).includes("changed-files"),
      );
      assert.deepEqual(
        requireStringArray(pausedEffectiveAcceptance.stopRules, "paused stop rules"),
        [],
      );
      assert.deepEqual(
        pausedCurrentAcceptance.effectiveAcceptance,
        pausedEffectiveAcceptance,
        "both paused children retain the same inferred contract",
      );

      const resumed = await executor.execute(
        "resume-paused-parallel-acceptance-resume",
        {
          action: "resume",
          id: asyncId,
          index: 0,
          message: "Inspect child a and summarize the resume note, read-only.",
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
      const revivedPayload: unknown = JSON.parse(
        fs.readFileSync(path.join(RESULTS_DIR, `${revivedId}.json`), "utf-8"),
      );
      const revivedAcceptance = readResultAcceptance(revivedPayload);
      assert.equal(revivedAcceptance.status, "checked");
      assert.deepEqual(revivedAcceptance.effectiveAcceptance, pausedEffectiveAcceptance);
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
        const observedExecuteAsyncSingle: typeof executeAsyncSingle = (id, params) => {
          assert.equal(params.maxOutput, undefined);
          return executeAsyncSingle(id, params);
        };
        const { executor } = makeExecutor({ executeAsyncSingle: observedExecuteAsyncSingle });

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
        await waitForAsyncResultFile(revivedId, scaleTestTimeout(10_000));
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
        const { executor, state } = makeExecutor();
        let revivedId: string | undefined;
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
              status: "completed",
              sessionFile,
              contextUsage,
              ...("contextPressure" in currentCase
                ? { contextPressure: currentCase.contextPressure }
                : {}),
              ...("contextPressureCrossedThresholds" in currentCase
                ? { contextPressureCrossedThresholds: currentCase.contextPressureCrossedThresholds }
                : {}),
            },
          ],
        });
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
      const acceptance = pausedAcceptanceLedger();
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
                  acceptance,
                },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );
        const { executor, state } = makeExecutor();
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
              contextUsage,
              contextPressure,
              contextPressureCrossedThresholds,
              acceptance,
            },
          ],
        });
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
      const acceptance = pausedAcceptanceLedger();
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
            acceptance,
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

    it("retains role-timeout poison when recovering from a result after status removal", async () => {
      const runId = `resume-result-only-poisoned-timeout-${Date.now()}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const statusPath = path.join(asyncDir, "status.json");
      const resultPath = path.join(RESULTS_DIR, `${runId}.json`);
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        statusPath,
        JSON.stringify(
          {
            runId,
            mode: "single",
            state: "failed",
            startedAt: 100,
            endedAt: 200,
            lastUpdate: 200,
            cwd: tempDir,
            steps: [
              {
                agent: "worker",
                status: "failed",
                sessionFile,
                timedOut: true,
                timeoutOwner: "role",
                activeRuntimeMs: 100,
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
      fs.writeFileSync(
        resultPath,
        JSON.stringify(
          {
            id: runId,
            agent: "worker",
            mode: "single",
            state: "failed",
            success: false,
            cwd: tempDir,
            asyncDir,
            results: [
              {
                agent: "worker",
                success: false,
                output: "role timeout evidence",
                sessionFile,
                timedOut: true,
                timeoutOwner: "role",
                activeRuntimeMs: 100,
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const beforeStatus = fs.readFileSync(statusPath);
      const beforeResult = fs.readFileSync(resultPath);
      try {
        const { executor } = makeExecutor({
          agents: [makeAgent("worker", { maxExecutionTimeMs: 1_000 })],
        });
        const statusResume = await executor.execute(
          "resume-result-only-poison-status",
          { action: "resume", id: runId, message: "Continue before status removal." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(statusResume.isError, true);
        assert.equal(
          statusResume.content[0]?.text,
          "Agent 'worker' has exhausted its maxExecutionTimeMs ceiling; persisted role-timeout evidence permanently retires this instance.",
        );
        assert.equal(mockPi.callCount(), 0);
        assert.deepEqual(fs.readFileSync(statusPath), beforeStatus);
        assert.deepEqual(fs.readFileSync(resultPath), beforeResult);

        fs.rmSync(asyncDir, { recursive: true, force: true });
        const resultOnlyResume = await executor.execute(
          "resume-result-only-poison-after-status-removal",
          { action: "resume", id: runId, message: "Continue from the saved result." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(resultOnlyResume.isError, true);
        assert.equal(
          resultOnlyResume.content[0]?.text,
          "Agent 'worker' has exhausted its maxExecutionTimeMs ceiling; persisted role-timeout evidence permanently retires this instance.",
        );
        assert.equal(mockPi.callCount(), 0);
        assert.deepEqual(fs.readFileSync(resultPath), beforeResult);
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
        fs.rmSync(resultPath, { force: true });
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
        const result = await executor.execute(
          "resume-background-result-only",
          {
            action: "resume",
            id: runId,
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
      await waitForAsyncResultFile(revivedId, scaleTestTimeout(10_000));
    });
  },
);
