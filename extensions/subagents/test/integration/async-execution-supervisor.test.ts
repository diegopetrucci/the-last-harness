/**
 * Integration tests for async execution – supervisor pause/resume/reload/races.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createEventBus,
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  makeAgentConfigs,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import { deliverInterruptRequest } from "../../src/runs/background/control-channel.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { writeNormalizedLifecycleStatus } from "../../src/runs/shared/lifecycle-state.ts";
import {
  ASYNC_DIR,
  type AsyncStatusPayload,
  RESULTS_DIR,
  createSubagentExecutor,
  executeAsyncChain,
  executeAsyncSingle,
  readAsyncPayload,
  readMockPiArgs,
  removeLifecycleLock,
  startedMockPiPids,
  waitForAsyncState,
  waitForAsyncStatusPredicate,
  waitForMockPiCall,
  waitForMockPiSignal,
  waitForPidsToExit,
  assertPidExited,
  writeLifecycleLock,
} from "../support/async-execution-helpers.ts";

describe("async execution utilities", () => {
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

  function makeAsyncExecutor(agents = [makeAgent("worker")]) {
    return createSubagentExecutor!({
      pi: { events: createEventBus(), getSessionName: () => undefined },
      state: {
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
      },
      config: {},
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (p: string) => p,
      discoverAgents: () => ({ agents }),
    });
  }

  it(
    "pauses async supervisor requests durably, reload resume preserves packaged identity, and stays single-claim",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const resumeTimeoutMs = scaleTestTimeout(1_000);
      const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
      const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
      const originalGuidanceMarker = process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV];
      const agentDir = path.join(tempDir, "profile");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = "1";
      const canonicalDeveloper = makeAgent("developer", {
        maxExecutionTimeMs: 5_000,
        acceptanceRole: "writer",
        filePath: path.join(agentDir, "tlh", "agents", "subagents", "developer.md"),
      });
      process.env.MOCK_PI_SESSION_DIR_FILE = "1";
      try {
        const id = `async-supervisor-pause-${Date.now().toString(36)}`;
        let runnerPid: number | undefined;
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
          ],
          keepAliveAfterFinalMessageMs: 5_000,
        });
        const started = executeAsyncSingle!(id, {
          agent: "developer",
          task: "Ask for a supervisor decision and stop there.",
          agentConfig: canonicalDeveloper,
          ctx: {
            pi: {
              events: {
                emit(event: string, payload: unknown) {
                  if (
                    event === "subagent:async-started" &&
                    payload &&
                    typeof payload === "object" &&
                    "pid" in payload
                  ) {
                    runnerPid = (payload as { pid?: number }).pid;
                  }
                },
              },
            },
            cwd: tempDir,
            currentSessionId: "session-1",
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
        assert.equal(started.isError, undefined);
        const asyncDir = path.join(ASYNC_DIR, id);
        assert.ok(runnerPid, "expected async runner pid from started event");
        await waitForMockPiCall(mockPi, 0);
        const childPids = startedMockPiPids(mockPi);
        assert.equal(childPids.length, 1);
        await waitForAsyncState(asyncDir, "paused");
        const status = JSON.parse(
          fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
        ) as any;
        assert.equal(status.state, "paused");
        assert.equal(status.pid, undefined);
        assert.equal(status.pause?.kind, "awaiting_supervisor");
        assert.equal(status.pause?.ownerPid, undefined);
        assert.equal(status.steps?.[0]?.terminationReason, "paused");
        assert.equal(status.pause?.request?.tool, "contact_supervisor");
        assert.equal(status.steps?.[0]?.status, "paused");
        assert.equal(status.steps?.[0]?.pause?.kind, "awaiting_supervisor");
        assert.equal(status.steps?.[0]?.acceptance?.status, "skipped");
        assert.ok((status.steps?.[0]?.activeRuntimeMs ?? 0) > 0);
        const pausedActiveRuntimeMs = status.steps?.[0]?.activeRuntimeMs;
        const payload = (await readAsyncPayload(id)) as any;
        assert.equal(payload.state, "paused");
        assert.equal(payload.pause?.kind, "awaiting_supervisor");
        assert.equal(payload.results?.[0]?.pause?.kind, "awaiting_supervisor");
        await waitForPidsToExit([runnerPid, ...childPids], `paused async supervisor run ${id}`);
        assert.equal(mockPi.callCount(), 1);

        const resumeTarget = resolveAsyncResumeTarget({ id });
        assert.equal(resumeTarget.kind, "revive");
        assert.equal(resumeTarget.pauseKind, "awaiting_supervisor");
        mockPi.onCall({
          echoEnv: [SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV],
        });
        const reloaded = makeAsyncExecutor([canonicalDeveloper]);
        await reloaded.execute(
          "async-supervisor-resume",
          {
            action: "resume",
            id,
            message: "Supervisor replied: continue.",
            timeoutMs: resumeTimeoutMs,
          },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        await waitForMockPiCall(mockPi, 1);
        await waitForAsyncState(asyncDir, "continued");
        assert.equal(mockPi.callCount(), 2);
        const continuedStatus = JSON.parse(
          fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
        ) as any;
        assert.equal(continuedStatus.state, "continued");
        assert.equal(typeof continuedStatus.lifecycle?.continuation?.continuationRunId, "string");
        assert.equal(continuedStatus.pid, undefined);
        const continuationPayload = await readAsyncPayload(
          continuedStatus.lifecycle.continuation.continuationRunId,
        );
        assert.equal(continuationPayload.state, "complete");
        assert.deepEqual(JSON.parse(continuationPayload.results[0]?.output ?? "{}"), {
          [SUBAGENT_CHILD_AGENT_ENV]: "developer",
          [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV]: "1",
        });
        assert.equal(continuationPayload.timeoutMs, resumeTimeoutMs);
        assert.ok((continuationPayload.results[0]?.activeRuntimeMs ?? 0) >= pausedActiveRuntimeMs);
        const continuationStatus = JSON.parse(
          fs.readFileSync(
            path.join(
              ASYNC_DIR,
              continuedStatus.lifecycle.continuation.continuationRunId,
              "status.json",
            ),
            "utf-8",
          ),
        ) as AsyncStatusPayload;
        assert.equal(continuationStatus.steps?.[0]?.timeoutMs, resumeTimeoutMs);
        assert.ok((continuationStatus.steps?.[0]?.activeRuntimeMs ?? 0) >= pausedActiveRuntimeMs);
        assert.notEqual(continuationPayload.results[0]?.acceptance?.status, "skipped");
        assert.equal(continuationPayload.results[0]?.acceptance?.status, "checked");

        const duplicate = await reloaded.execute(
          "async-supervisor-resume-duplicate",
          { action: "resume", id, message: "Supervisor replied: continue." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(duplicate.isError, true);
        assert.match(
          duplicate.content[0]?.text ?? "",
          /already launched continuation|already claimed/i,
        );
        assert.equal(mockPi.callCount(), 2);
      } finally {
        if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
        else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        if (originalGuidanceMarker === undefined)
          delete process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV];
        else process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = originalGuidanceMarker;
      }
    },
  );

  it(
    "blocks unsafe durable resume before claiming or spawning and preserves paused artifacts",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
      process.env.MOCK_PI_SESSION_DIR_FILE = "1";
      try {
        const id = `async-supervisor-context-gate-${Date.now().toString(36)}`;
        mockPi.onCall({
          steps: [
            {
              jsonl: [
                events.toolStart("intercom", { action: "ask", to: "main", message: "Need input" }),
              ],
            },
          ],
          keepAliveAfterFinalMessageMs: 5_000,
        });
        executeAsyncSingle!(id, {
          agent: "worker",
          task: "Ask on intercom and wait.",
          agentConfig: makeAgent("worker"),
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
          sessionRoot: path.join(tempDir, "sessions"),
          maxSubagentDepth: 2,
        });
        const asyncDir = path.join(ASYNC_DIR, id);
        await waitForAsyncState(asyncDir, "paused", scaleTestTimeout(10_000));
        await waitForPidsToExit(startedMockPiPids(mockPi), `paused context-gate run ${id}`);
        const statusPath = path.join(asyncDir, "status.json");
        const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
        status.steps![0]!.contextUsage = {
          contextTokens: 800,
          contextWindow: 1000,
          peakTokens: 1200,
        };
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf-8");
        const beforeStatus = fs.readFileSync(statusPath);
        const initialChildSpawnCount = startedMockPiPids(mockPi).length;
        const sessionFile = status.steps![0]!.sessionFile!;
        const beforeSession = fs.readFileSync(sessionFile);
        const beforeResult = fs.existsSync(path.join(RESULTS_DIR, `${id}.json`))
          ? fs.readFileSync(path.join(RESULTS_DIR, `${id}.json`))
          : undefined;

        const resumed = await makeAsyncExecutor([makeAgent("worker")]).execute(
          "async-supervisor-context-gate-resume",
          { action: "resume", id, message: "Continue.", model: "explicit/model" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(resumed.isError, true);
        assert.equal(startedMockPiPids(mockPi).length - initialChildSpawnCount, 0);
        assert.match(resumed.content[0]?.text ?? "", /used tokens 800/);
        assert.match(resumed.content[0]?.text ?? "", /context window 1000/);
        assert.match(resumed.content[0]?.text ?? "", /80\.00%/);
        assert.match(resumed.content[0]?.text ?? "", /remaining tokens 200/);
        assert.match(resumed.content[0]?.text ?? "", /fresh narrowly scoped child/);
        assert.deepEqual(fs.readFileSync(statusPath), beforeStatus);
        assert.deepEqual(fs.readFileSync(sessionFile), beforeSession);
        if (beforeResult)
          assert.deepEqual(fs.readFileSync(path.join(RESULTS_DIR, `${id}.json`)), beforeResult);
        const afterStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
        assert.equal(afterStatus.state, "paused");
        assert.equal(afterStatus.lifecycle?.continuation, undefined);
      } finally {
        if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
        else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
      }
    },
  );

  it(
    "restores the paused child model when the reloaded parent uses a different model",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
      process.env.MOCK_PI_SESSION_DIR_FILE = "1";
      try {
        const id = `async-supervisor-model-restore-${Date.now().toString(36)}`;
        const availableModels = [
          { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
          { provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
        ];
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
          ],
          keepAliveAfterFinalMessageMs: 5_000,
        });
        executeAsyncSingle!(id, {
          agent: "worker",
          task: "Ask for a supervisor decision and stop there.",
          agentConfig: makeAgent("worker", {
            model: "anthropic/claude-sonnet-4",
            thinking: "high",
          }),
          ctx: {
            pi: { events: { emit() {} } },
            cwd: tempDir,
            currentSessionId: "session-1",
            currentModelProvider: "anthropic",
            currentModel: { provider: "anthropic", id: "claude-sonnet-4" },
          },
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
        const asyncDir = path.join(ASYNC_DIR, id);
        await waitForAsyncState(asyncDir, "paused", scaleTestTimeout(10_000));
        const pausedStatus = JSON.parse(
          fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
        ) as any;
        assert.deepEqual(pausedStatus.steps?.[0]?.modelIdentity, {
          provider: "anthropic",
          model: "claude-sonnet-4",
          thinking: "high",
        });
        await waitForPidsToExit(startedMockPiPids(mockPi), `paused model-identity run ${id}`);

        mockPi.onCall({ output: "resumed on the persisted child model" });
        const reloaded = makeAsyncExecutor([
          makeAgent("worker", { model: "openai/gpt-5", thinking: "low" }),
        ]);

        const resumed = await reloaded.execute(
          "async-supervisor-model-restore-resume",
          { action: "resume", id, message: "Supervisor replied: continue." },
          new AbortController().signal,
          undefined,
          {
            ...makeMinimalCtx(tempDir),
            model: { provider: "openai", id: "gpt-5" },
            modelRegistry: { getAvailable: () => availableModels },
          },
        );
        assert.equal(resumed.isError, undefined);
        await waitForAsyncState(asyncDir, "continued", scaleTestTimeout(10_000));
        const continuedStatus = JSON.parse(
          fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
        ) as any;
        const continuationRunId = continuedStatus.lifecycle?.continuation?.continuationRunId;
        assert.equal(typeof continuationRunId, "string");
        const continuationPayload = await readAsyncPayload(continuationRunId);
        assert.equal(continuationPayload.results?.[0]?.model, "anthropic/claude-sonnet-4:high");
        assert.deepEqual(continuationPayload.results?.[0]?.modelIdentity, {
          provider: "anthropic",
          model: "claude-sonnet-4",
          thinking: "high",
        });
        assert.equal(continuationPayload.results?.[0]?.modelResolution?.kind, "restored");
        assert.match(
          continuationPayload.results?.[0]?.modelResolution?.reason ?? "",
          /instead of the current parent model/,
        );
        const resumedArgs = readMockPiArgs(mockPi, 1);
        assert.equal(
          resumedArgs[resumedArgs.indexOf("--model") + 1],
          "anthropic/claude-sonnet-4:high",
        );
      } finally {
        if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
        else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
      }
    },
  );

  it(
    "resumes paused async supervisor runs unchanged after disk reload and evaluates continuation acceptance once",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
      process.env.MOCK_PI_SESSION_DIR_FILE = "1";
      try {
        const id = `async-supervisor-resume-unchanged-${Date.now().toString(36)}`;
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
          ],
          keepAliveAfterFinalMessageMs: 5_000,
        });
        executeAsyncSingle!(id, {
          agent: "worker",
          task: "Ask for a supervisor decision and stop there.",
          agentConfig: makeAgent("worker"),
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
          sessionRoot: path.join(tempDir, "sessions"),
          maxSubagentDepth: 2,
        });
        const asyncDir = path.join(ASYNC_DIR, id);
        await waitForAsyncState(asyncDir, "paused");
        const pausedPayload = await readAsyncPayload(id);
        assert.equal(pausedPayload.results[0]?.acceptance?.status, "skipped");
        mockPi.onCall({ output: "resumed unchanged after reload" });
        const reloaded = makeAsyncExecutor([makeAgent("worker")]);
        const resumed = await reloaded.execute(
          "async-supervisor-resume-unchanged",
          { action: "resume", id },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(resumed.isError, undefined);
        await waitForAsyncState(asyncDir, "continued");
        const continuedStatus = JSON.parse(
          fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
        ) as any;
        const continuationRunId = continuedStatus.lifecycle?.continuation?.continuationRunId;
        assert.equal(typeof continuationRunId, "string");
        const continuationPayload = await readAsyncPayload(continuationRunId);
        assert.equal(continuationPayload.state, "complete");
        assert.equal(continuationPayload.results[0]?.output, "resumed unchanged after reload");
        assert.notEqual(continuationPayload.results[0]?.acceptance?.status, "skipped");
        assert.equal(continuationPayload.results[0]?.acceptance?.status, "checked");
      } finally {
        if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
        else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
      }
    },
  );

  it(
    "cancels paused async supervisor runs after disk reload without reviving them",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const id = `async-supervisor-cancel-${Date.now().toString(36)}`;
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("intercom", { action: "ask", to: "main", message: "Need input" }),
            ],
          },
        ],
        keepAliveAfterFinalMessageMs: 5_000,
      });
      executeAsyncSingle!(id, {
        agent: "worker",
        task: "Ask on intercom and wait.",
        agentConfig: makeAgent("worker"),
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
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      const asyncDir = path.join(ASYNC_DIR, id);
      await waitForAsyncState(asyncDir, "paused");
      const reloaded = makeAsyncExecutor();
      const cancelled = await reloaded.execute(
        "async-supervisor-cancelled",
        { action: "interrupt", id },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(cancelled.isError, undefined);
      assert.match(cancelled.content[0]?.text ?? "", /cancelled/i);
      assert.equal(mockPi.callCount(), 1);
      const cancelledStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as any;
      assert.equal(cancelledStatus.state, "cancelled");
      assert.equal(cancelledStatus.pid, undefined);
      assert.equal(cancelledStatus.pause?.ownerPid, undefined);
      const cancelledAgain = await reloaded.execute(
        "async-supervisor-cancelled-again",
        { action: "interrupt", id },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(cancelledAgain.isError, undefined);
      assert.match(cancelledAgain.content[0]?.text ?? "", /already cancelled/i);
    },
  );

  it(
    "recovers dead-owner paused continuation claims before async resume after reload",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
      process.env.MOCK_PI_SESSION_DIR_FILE = "1";
      try {
        const id = `async-supervisor-resume-recover-${Date.now().toString(36)}`;
        mockPi.onCall({
          steps: [
            {
              jsonl: [
                events.toolStart("intercom", { action: "ask", to: "main", message: "Need input" }),
              ],
            },
          ],
          keepAliveAfterFinalMessageMs: 5_000,
        });
        executeAsyncSingle!(id, {
          agent: "worker",
          task: "Ask on intercom and wait.",
          agentConfig: makeAgent("worker"),
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
          sessionRoot: path.join(tempDir, "sessions"),
          maxSubagentDepth: 2,
        });
        const asyncDir = path.join(ASYNC_DIR, id);
        await waitForAsyncState(asyncDir, "paused");
        const pausedStatus = JSON.parse(
          fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
        ) as any;
        pausedStatus.lifecycle = {
          ...pausedStatus.lifecycle,
          continuation: { claimToken: `claim-${id}`, claimedAt: Date.now(), ownerPid: 999999 },
        };
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(pausedStatus, null, 2),
          "utf-8",
        );
        mockPi.onCall({ output: "resumed after dead-owner recovery" });
        const reloaded = makeAsyncExecutor([makeAgent("worker")]);
        const resumed = await reloaded.execute(
          "async-supervisor-resume-recover",
          { action: "resume", id, message: "Continue." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(resumed.isError, undefined);
        await waitForAsyncState(asyncDir, "continued");
        const continuedStatus = JSON.parse(
          fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
        ) as any;
        assert.equal(continuedStatus.state, "continued");
        assert.equal(typeof continuedStatus.lifecycle?.continuation?.continuationRunId, "string");
      } finally {
        if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
        else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
      }
    },
  );

  it(
    "recovers dead-owner paused continuation claims before async cancel after reload",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const id = `async-supervisor-cancel-recover-${Date.now().toString(36)}`;
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("intercom", { action: "ask", to: "main", message: "Need input" }),
            ],
          },
        ],
        keepAliveAfterFinalMessageMs: 5_000,
      });
      executeAsyncSingle!(id, {
        agent: "worker",
        task: "Ask on intercom and wait.",
        agentConfig: makeAgent("worker"),
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
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      const asyncDir = path.join(ASYNC_DIR, id);
      await waitForAsyncState(asyncDir, "paused");
      const pausedStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as any;
      pausedStatus.lifecycle = {
        ...pausedStatus.lifecycle,
        continuation: { claimToken: `claim-${id}`, claimedAt: Date.now(), ownerPid: 999999 },
      };
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(pausedStatus, null, 2),
        "utf-8",
      );
      const reloaded = makeAsyncExecutor();
      const cancelled = await reloaded.execute(
        "async-supervisor-cancel-recover",
        { action: "interrupt", id },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(cancelled.isError, undefined);
      const cancelledStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as any;
      assert.equal(cancelledStatus.state, "cancelled");
      assert.equal(cancelledStatus.lifecycle?.continuation, undefined);
    },
  );

  it(
    "makes paused async resume versus cancel races deterministic after reload",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const id = `async-supervisor-race-${Date.now().toString(36)}`;
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
        ],
        keepAliveAfterFinalMessageMs: 5_000,
      });
      executeAsyncSingle!(id, {
        agent: "worker",
        task: "Ask for a supervisor decision and stop there.",
        agentConfig: makeAgent("worker"),
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
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      const asyncDir = path.join(ASYNC_DIR, id);
      await waitForAsyncState(asyncDir, "paused");
      mockPi.onCall({ output: "resumed race winner" });
      const reloaded = makeAsyncExecutor([makeAgent("worker")]);

      const [resumeResult, cancelResult] = await Promise.allSettled([
        reloaded.execute(
          "async-supervisor-race-resume",
          { action: "resume", id, message: "Supervisor replied: continue." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        ),
        reloaded.execute(
          "async-supervisor-race-cancel",
          { action: "interrupt", id },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        ),
      ]);
      const settledStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as any;
      assert.ok(["continued", "cancelled"].includes(settledStatus.state));
      assert.ok(
        mockPi.callCount() <= 2,
        `expected at most one continuation spawn, saw ${mockPi.callCount()}`,
      );
      const successCount = [resumeResult, cancelResult].filter(
        (entry) => entry.status === "fulfilled" && entry.value.isError === undefined,
      ).length;
      assert.equal(successCount, 1);
      if (settledStatus.state === "continued") {
        assert.equal(mockPi.callCount(), 2);
        assert.equal(typeof settledStatus.lifecycle?.continuation?.continuationRunId, "string");
        const continuationPayload = await readAsyncPayload(
          settledStatus.lifecycle.continuation.continuationRunId,
        );
        assert.equal(continuationPayload.state, "complete");
      } else {
        assert.equal(mockPi.callCount(), 1);
      }
    },
  );

  it(
    "hard-kills an async supervisor-paused child that ignores SIGINT and SIGTERM and reaps owned pids",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const id = `async-supervisor-hard-kill-${Date.now().toString(36)}`;
      let runnerPid: number | undefined;
      mockPi.onCall({
        steps: [
          {
            delay: 250,
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
        ],
        ignoreSigint: true,
        ignoreSigterm: true,
        spawnStubbornDescendants: true,
        keepAliveAfterFinalMessageMs: 30_000,
      });
      const startedAt = Date.now();
      executeAsyncSingle!(id, {
        agent: "worker",
        task: "Ask for a supervisor decision and stop there.",
        agentConfig: makeAgent("worker"),
        ctx: {
          pi: {
            events: {
              emit(event: string, payload: unknown) {
                if (
                  event === "subagent:async-started" &&
                  payload &&
                  typeof payload === "object" &&
                  "pid" in payload
                ) {
                  runnerPid = (payload as { pid?: number }).pid;
                }
              },
            },
          },
          cwd: tempDir,
          currentSessionId: "session-1",
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
      const asyncDir = path.join(ASYNC_DIR, id);
      const pausingStatus = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) =>
          status.state === "pausing" &&
          typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number",
        "pausing before interrupt hard kill",
      );
      await waitForMockPiCall(mockPi, 0);
      const childPids = startedMockPiPids(mockPi);
      assert.equal(childPids.length, 1);
      await waitForMockPiSignal(mockPi, childPids[0]!, "SIGTERM");
      const payload = await readAsyncPayload(id);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(payload.state, "paused");
      assert.equal(payload.pause?.kind, "awaiting_supervisor");
      assert.ok(elapsedMs < 10_000, `expected bounded interrupt hard kill, took ${elapsedMs}ms`);
      const descendants = JSON.parse(
        fs.readFileSync(path.join(mockPi.dir, `descendants-${childPids[0]}.json`), "utf-8"),
      ) as { childPid: number; grandchildPid: number };
      await waitForPidsToExit(
        [
          runnerPid,
          pausingStatus.pid as number | undefined,
          ...childPids,
          descendants.childPid,
          descendants.grandchildPid,
        ],
        `hard-killed async supervisor pause ${id}`,
      );
      assertPidExited(runnerPid, "runner");
      assertPidExited(childPids[0], "child");
      assertPidExited(descendants.childPid, "descendant child");
      assertPidExited(descendants.grandchildPid, "descendant grandchild");
    },
  );

  it(
    "publishes privacy-safe failed state after a pre-checkpoint supervisor lifecycle lock failure",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const id = `async-supervisor-lock-pre-${Date.now().toString(36)}`;
      mockPi.onCall({
        steps: [
          {
            delay: 1_000,
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
        ],
        keepAliveAfterFinalMessageMs: 5_000,
      });
      executeAsyncSingle!(id, {
        agent: "worker",
        task: "Ask for a supervisor decision and stop there.",
        agentConfig: makeAgent("worker"),
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
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      const asyncDir = path.join(ASYNC_DIR, id);
      const runningStatus = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) =>
          status.state === "running" &&
          typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number",
        "running pid before lock contention",
      );
      await waitForMockPiCall(mockPi, 0);
      const childPids = startedMockPiPids(mockPi);
      assert.equal(childPids.length, 1);
      writeLifecycleLock(asyncDir);
      const payload = await readAsyncPayload(id);
      const lockedStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(payload.state, "failed");
      assert.equal(lockedStatus.state, "failed");
      assert.equal((lockedStatus as AsyncStatusPayload & { pid?: number }).pid, undefined);
      assert.equal(lockedStatus.pause, undefined);
      assert.match(payload.error ?? "", /supervisor lifecycle update failed/i);
      assert.equal(payload.pause, undefined);
      assert.equal(fs.readdirSync(RESULTS_DIR).filter((name) => name === `${id}.json`).length, 1);
      await waitForPidsToExit(
        [runningStatus.pid as number | undefined, ...childPids],
        `failed async supervisor lock contention ${id}`,
      );
      removeLifecycleLock(asyncDir);
    },
  );

  it(
    "preserves an adopted concurrent terminal winner during supervisor pause finalization",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const id = `async-supervisor-concurrent-terminal-${Date.now().toString(36)}`;
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
        ],
        ignoreSigint: true,
        keepAliveAfterFinalMessageMs: 5_000,
      });
      executeAsyncSingle!(id, {
        agent: "worker",
        task: "Ask for a supervisor decision and stop there.",
        agentConfig: makeAgent("worker"),
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
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      const asyncDir = path.join(ASYNC_DIR, id);
      const pausingStatus = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) => status.state === "pausing",
        "pausing before concurrent terminal winner",
      );
      // Hold the lifecycle lock to prevent the runner's finalization CAS write from
      // overwriting the concurrent terminal winner we are about to inject. Note:
      // with skip-on-exhaustion (FIX 1, tlhm-8typ), the runner's intermediate
      // post-child status writes are skipped while the lock is held. We therefore
      // write the cancelled status immediately without waiting for the step-update
      // write — the adopted cancelled status already carries the correct step state.
      writeLifecycleLock(asyncDir);
      // Write the concurrent terminal status immediately; writeNormalizedLifecycleStatus
      // bypasses the lifecycle lock so this write succeeds even while the lock is held.
      writeNormalizedLifecycleStatus(asyncDir, {
        ...pausingStatus,
        state: "cancelled",
        pid: undefined,
        endedAt: Date.now(),
        lastUpdate: Date.now(),
        cancel: { summary: "Cancelled by test", cancelledAt: Date.now() },
        pause: pausingStatus.pause
          ? { ...pausingStatus.pause, ownerPid: undefined }
          : pausingStatus.pause,
        steps: pausingStatus.steps?.map((step) => ({
          ...step,
          status:
            step.status === "complete" || step.status === "completed" ? step.status : "cancelled",
          exitCode: step.exitCode ?? 0,
          pause: step.pause ? { ...step.pause, ownerPid: undefined } : step.pause,
        })),
        lifecycle: {
          generation:
            ((pausingStatus as AsyncStatusPayload & { lifecycle?: { generation?: number } })
              .lifecycle?.generation ?? 0) + 1,
        },
      });
      // The runner's finalization CAS will fail (lock held), causing it to call
      // adoptConcurrentTerminalStatus which reads the cancelled status and exits.
      const payload = await readAsyncPayload(id);
      const status = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(payload.state, "cancelled");
      assert.equal(status.state, "cancelled");
    },
  );

  it(
    "keeps supervisor-first versus external-interrupt outcomes deterministic",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const supervisorFirstId = `async-supervisor-first-${Date.now().toString(36)}`;
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
        ],
        ignoreSigint: true,
        keepAliveAfterFinalMessageMs: 5_000,
      });
      executeAsyncSingle!(supervisorFirstId, {
        agent: "worker",
        task: "Ask for a supervisor decision and stop there.",
        agentConfig: makeAgent("worker"),
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
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      const supervisorFirstDir = path.join(ASYNC_DIR, supervisorFirstId);
      const pausing = await waitForAsyncStatusPredicate(
        supervisorFirstDir,
        (status) =>
          status.state === "pausing" &&
          typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number",
        "supervisor-first pausing",
      );
      deliverInterruptRequest({
        asyncDir: supervisorFirstDir,
        pid: (pausing as AsyncStatusPayload & { pid?: number }).pid,
        source: "test-race",
      });
      const supervisorFirstPayload = await readAsyncPayload(supervisorFirstId);
      assert.equal(supervisorFirstPayload.state, "paused");
      assert.equal(supervisorFirstPayload.pause?.kind, "awaiting_supervisor");

      const interruptFirstId = `async-interrupt-first-${Date.now().toString(36)}`;
      mockPi.onCall({
        steps: [
          {
            delay: 800,
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
        ],
        keepAliveAfterFinalMessageMs: 5_000,
      });
      executeAsyncSingle!(interruptFirstId, {
        agent: "worker",
        task: "Ask for a supervisor decision and stop there.",
        agentConfig: makeAgent("worker"),
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
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      const interruptFirstDir = path.join(ASYNC_DIR, interruptFirstId);
      const running = await waitForAsyncStatusPredicate(
        interruptFirstDir,
        (status) =>
          status.state === "running" &&
          typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number",
        "interrupt-first running",
      );
      deliverInterruptRequest({
        asyncDir: interruptFirstDir,
        pid: (running as AsyncStatusPayload & { pid?: number }).pid,
        source: "test-race",
      });
      const interruptFirstPayload = await readAsyncPayload(interruptFirstId);
      assert.equal(interruptFirstPayload.state, "paused");
      assert.equal(interruptFirstPayload.pause, undefined);
      assert.equal(
        interruptFirstPayload.summary,
        "Paused after interrupt. Waiting for explicit next action.",
      );
    },
  );

  it(
    "keeps non-blocking supervisor updates live and pauses only active cohort children for supervisor blocks",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", { reason: "progress_update", message: "FYI" }),
              events.toolResult("contact_supervisor", "sent"),
              events.toolEnd("contact_supervisor"),
            ],
          },
          { jsonl: [events.assistantMessage("non-blocking update finished")] },
        ],
      });
      const progressId = `async-non-blocking-update-${Date.now().toString(36)}`;
      executeAsyncSingle!(progressId, {
        agent: "worker",
        task: "Provide a short non-blocking status update only. Do not edit files.",
        agentConfig: makeAgent("worker", { acceptanceRole: "read-only" }),
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
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      const progressPayload = (await readAsyncPayload(progressId)) as any;
      assert.equal(progressPayload.state, "complete");
      assert.equal(progressPayload.pause, undefined);

      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("intercom", { action: "send", to: "main", message: "FYI" }),
              events.toolResult("intercom", "sent"),
              events.toolEnd("intercom"),
            ],
          },
          { jsonl: [events.assistantMessage("intercom update finished")] },
        ],
      });
      const intercomId = `async-non-blocking-intercom-${Date.now().toString(36)}`;
      executeAsyncSingle!(intercomId, {
        agent: "worker",
        task: "Provide a short non-blocking status update only. Do not edit files.",
        agentConfig: makeAgent("worker", { acceptanceRole: "read-only" }),
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
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      const intercomPayload = (await readAsyncPayload(intercomId)) as any;
      assert.equal(intercomPayload.state, "complete");
      assert.equal(intercomPayload.pause, undefined);
      const existingPids = new Set(startedMockPiPids(mockPi));

      const cohortId = `async-supervisor-cohort-${Date.now().toString(36)}`;
      let runnerPid: number | undefined;
      mockPi.onCall({ matchArgIncludes: "complete setup", output: "setup complete" });
      mockPi.onCall({
        matchArgIncludes: "ask supervisor",
        steps: [
          {
            delay: 200,
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need direction",
              }),
            ],
          },
        ],
        keepAliveAfterFinalMessageMs: 5_000,
      });
      mockPi.onCall({
        matchArgIncludes: "work in parallel",
        delay: 2_000,
        jsonl: [events.assistantMessage("parallel sibling should be interrupted")],
      });
      const started = executeAsyncChain!(cohortId, {
        chain: [
          { agent: "a", task: "complete setup" },
          {
            parallel: [
              { agent: "b", task: "ask supervisor" },
              { agent: "c", task: "work in parallel" },
            ],
          },
          { agent: "d", task: "must remain pending" },
        ],
        agents: makeAgentConfigs(["a", "b", "c", "d"]),
        ctx: {
          pi: {
            events: {
              emit(event: string, payload: unknown) {
                if (
                  event === "subagent:async-started" &&
                  payload &&
                  typeof payload === "object" &&
                  "pid" in payload
                ) {
                  runnerPid = (payload as { pid?: number }).pid;
                }
              },
            },
          },
          cwd: tempDir,
          currentSessionId: "session-1",
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
      assert.equal(started.isError, undefined);
      const asyncDir = path.join(ASYNC_DIR, cohortId);
      assert.ok(runnerPid, "expected async runner pid from started event");
      await waitForMockPiCall(mockPi, 4);
      const childPids = startedMockPiPids(mockPi).filter((pid) => !existingPids.has(pid));
      assert.equal(childPids.length, 3);
      await waitForAsyncState(asyncDir, "paused");
      const status = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as any;
      assert.deepEqual(
        status.steps?.map((step: any) => step.status),
        ["complete", "paused", "paused", "pending"],
      );
      const requesterIndex =
        status.steps?.findIndex((step: any) => step.pause?.kind === "awaiting_supervisor") ?? -1;
      assert.ok(requesterIndex >= 0);
      const cohortIndex =
        status.steps?.findIndex(
          (step: any, index: number) =>
            index !== requesterIndex && step.pause?.kind === "cohort_pause",
        ) ?? -1;
      assert.ok(cohortIndex >= 0);
      assert.equal(status.pid, undefined);
      await readAsyncPayload(cohortId);
      await waitForPidsToExit([runnerPid, ...childPids], `paused async cohort ${cohortId}`);
    },
  );
});
